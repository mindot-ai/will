// ─────────────────────────────────────────────────────────────
// src/cognition/memory/vector.index.ts
// ─────────────────────────────────────────────────────────────

/**
 * Vector index interface — allows swapping different implementations.
 *
 * Implementations:
 *   - HNSWIndex (in-memory, deterministic)
 *   - QdrantClient (cloud)
 *   - PgVectorClient (Postgres)
 *   - PineconeClient (cloud)
 */

import type { VectorRecord, VectorQueryResult } from '#memory/vector.types'
import type { SeededPRNG } from '#core/types'
import { createPRNG } from '#core/utils'

/** Fixed fallback seed so an unwired index is still deterministic per insertion order. */
const DEFAULT_HNSW_SEED = 42

export interface VectorIndex {
  /** Insert a vector into the index */
  insert( record: VectorRecord ): Promise<void>

  /** Search for k nearest neighbors. Similarity-only — see VectorQueryFilter. */
  search(
    vector: number[],
    k: number,
    filter?: { minSimilarity?: number }
  ): Promise<VectorQueryResult[]>

  /** Delete a vector from the index */
  delete( id: string ): Promise<boolean>

  /** Get current size of index */
  readonly size: number

  /** Iterate all indexed ids in insertion order — lets callers rebuild an
   *  external id-set (e.g. the adapter's dedup/eviction set) after a load. */
  keys?(): IterableIterator<string>

  /** Serialize index to bytes for persistence (optional) */
  serialize?(): Uint8Array

  /** Deserialize index from bytes (optional) */
  deserialize?( bytes: Uint8Array ): Promise<void>

  /** Clear all entries */
  clear(): Promise<void>
}

export interface HNSWIndexConfig {
  dimensions?: number
  similarityMetric?: 'cosine' | 'euclidean' | 'dot'
  hnswM?: number
  hnswEfConstruction?: number
  /** Base-layer search beam width. Must be ≫ k for good recall; the effective
   *  beam is max(k, hnswEfSearch). Default 64. */
  hnswEfSearch?: number
  /** Seed for the level-assignment PRNG. Required for deterministic replay. */
  seed?: number
}

/**
 * HNSW-based vector index for semantic similarity search.
 *
 * In-memory index with optional persistence via StorageAdapter.
 * Designed to be rebuilt from _store on snapshot restore.
 * Deterministic for given insertion order (important for replay).
 */
export class HNSWIndex implements VectorIndex {
  private _nodes: Map<string, HNSWNode> = new Map()
  private _entryPoint: string | null = null
  private _maxLevel: number = 0
  private _config: HNSWIndexConfig
  private _seed: number
  private _prng: SeededPRNG

  constructor( config: HNSWIndexConfig = {} ){
    this._config = {
      dimensions: config.dimensions ?? 1536,
      similarityMetric: config.similarityMetric ?? 'cosine',
      hnswM: config.hnswM ?? 16,
      hnswEfConstruction: config.hnswEfConstruction ?? 200,
      hnswEfSearch: config.hnswEfSearch ?? 64
    }
    this._seed = config.seed ?? DEFAULT_HNSW_SEED
    this._prng = createPRNG( this._seed )
  }

  get size(): number {
    return this._nodes.size
  }

  /** Insertion-ordered ids (Map preserves insertion order; deserialize repopulates
   *  _nodes in the original order), so callers get oldest-first iteration. */
  keys(): IterableIterator<string> {
    return this._nodes.keys()
  }

  async insert( record: VectorRecord ): Promise<void> {
    if( this._nodes.has( record.id ) )
      await this.delete( record.id )

    const level = this._randomLevel()
    const node: HNSWNode = {
      id: record.id,
      vector: record.vector,
      level,
      connections: new Map()
    }

    for( let l = 0; l <= level; l++ )
      node.connections.set( l, new Set() )

    // Register the node up front so neighbour-list pruning below can resolve
    // `record.id` to its node while wiring bidirectional links. Safe: no
    // level-l edge points at the new node until *after* this insert's own
    // _searchLayer call for level l, so it can never appear in its own
    // candidate sets (which would change the deterministic graph).
    this._nodes.set( record.id, node )

    if( this._entryPoint === null ){
      this._entryPoint = record.id
      this._maxLevel = level

      return
    }

    const entryNode = this._nodes.get( this._entryPoint )!
    let currNode = entryNode

    for( let l = this._maxLevel; l > level; l-- ){
      const candidates = this._searchLayer( currNode, record.vector, l, 1 )
      currNode = candidates[0] ?? currNode
    }

    for( let l = Math.min( level, this._maxLevel ); l >= 0; l-- ){
      const candidates = this._searchLayer( currNode, record.vector, l, this._config.hnswEfConstruction! )
      const neighbors = this._selectNeighbors( record.vector, candidates, this._config.hnswM! )

      // Canonical HNSW degree caps: M for upper layers, M*2 at the base layer.
      const maxConn = l === 0 ? this._config.hnswM! * 2 : this._config.hnswM!

      for( const neighbor of neighbors ){
        if( neighbor.id === record.id ) continue   // never self-link

        node.connections.get( l )!.add( neighbor.id )

        const nset = neighbor.connections.get( l )!
        nset.add( record.id )
        // Shrink the touched neighbour back to its cap. Without this, popular
        // nodes accumulate back-links without bound → memory bloat and an
        // ever-slower _searchLayer (FN6). Re-selection is deterministic.
        if( nset.size > maxConn )
          this._shrinkConnections( neighbor, l, maxConn )
      }

      currNode = candidates[0] ?? currNode
    }

    if( level > this._maxLevel ){
      this._maxLevel = level
      this._entryPoint = record.id
    }
  }

  /**
   * Re-select a node's `level` connections down to `cap`, keeping the closest
   * by distance. Canonical HNSW neighbour pruning: bounds node degree so the
   * graph stays sparse and search stays fast. Asymmetric drops (the removed
   * peer may still link back) are expected and self-correct when that peer is
   * itself pruned — matching reference implementations.
   */
  private _shrinkConnections( node: HNSWNode, level: number, cap: number ): void {
    const set = node.connections.get( level )
    if( !set || set.size <= cap ) return

    const connected: HNSWNode[] = []
    for( const id of set ){
      const n = this._nodes.get( id )
      if( n ) connected.push( n )
    }

    const kept = this._selectNeighbors( node.vector, connected, cap )
    node.connections.set( level, new Set( kept.map( n => n.id ) ) )
  }

  async search(
    vector: number[],
    k: number,
    filter?: { minSimilarity?: number }
  ): Promise<VectorQueryResult[]> {
    if( this._entryPoint === null || this._nodes.size === 0 ) return []

    const entryNode = this._nodes.get( this._entryPoint )!
    let currNode = entryNode

    for( let l = this._maxLevel; l > 0; l-- ){
      const candidates = this._searchLayer( currNode, vector, l, 1 )
      currNode = candidates[0] ?? currNode
    }

    // Explore a base-layer beam much wider than k (canonical HNSW efSearch ≫ k),
    // then keep the top-k. With ef==k the greedy walk under-explored and capped
    // recall; widening it surfaces true nearest neighbours that a k-width beam
    // skipped. _searchLayer returns nearest-first, so slicing keeps the best k.
    const ef = Math.max( k, this._config.hnswEfSearch ?? 64 )
    const candidates = this._searchLayer( currNode, vector, 0, ef )
    const minSimilarity = filter?.minSimilarity ?? 0.35

    const results: VectorQueryResult[] = []
    for( const node of candidates ){
      const similarity = this._computeSimilarity( vector, node.vector )
      if( similarity >= minSimilarity )
        results.push({ episodeId: node.id, similarity })
    }

    return results.slice( 0, k )
  }

  async delete( id: string ): Promise<boolean> {
    const node = this._nodes.get( id )
    if( !node ) return false

    for( const [ level, neighbors ] of node.connections )
      for( const neighborId of neighbors ){
        const neighbor = this._nodes.get( neighborId )
        if( neighbor )
          neighbor.connections.get( level )?.delete( id )
      }

    this._nodes.delete( id )

    // Reselect the entry point when we removed it. The old code grabbed an
    // arbitrary `keys().next()` node — often a level-0 node — while _maxLevel
    // stayed high, so the top-down descent began at a node with no high-level
    // connections and returned only itself (compounding FN4). Promote the
    // highest-level remaining node and resync _maxLevel to it. Deterministic:
    // Map iteration is insertion order, ties resolve to the first inserted.
    if( this._entryPoint === id ){
      this._entryPoint = null
      this._maxLevel = 0
      for( const n of this._nodes.values() )
        if( this._entryPoint === null || n.level > this._maxLevel ){
          this._entryPoint = n.id
          this._maxLevel = n.level
        }
    }

    return true
  }

  async clear(): Promise<void> {
    this._nodes.clear()
    this._entryPoint = null
    this._maxLevel = 0
    // Reset the PRNG so a rebuild from the same insertion order (e.g.
    // rebuildFromStore on snapshot restore) reproduces the identical graph.
    this._prng = createPRNG( this._seed )
  }

  serialize(): Uint8Array {
    const data = {
      config: this._config,
      seed: this._seed,
      // Persist the live PRNG state so inserts after a load continue the
      // same deterministic sequence rather than restarting from the seed.
      // Mask to 32 bits: the Mulberry32 accumulator grows unbounded but only
      // its low 32 bits affect output, and createPRNG re-applies `>>> 0` on
      // load — storing the masked value keeps serialize/restore round-trips
      // byte-stable.
      prngState: this._prng.state >>> 0,
      entryPoint: this._entryPoint,
      maxLevel: this._maxLevel,
      nodes: Array.from( this._nodes.entries() ).map( ( [ id, node ] ) => ( {
        id,
        vector: node.vector,
        level: node.level,
        connections: Array.from( node.connections.entries() ).map( ( [ level, neighbors ] ) => ( {
          level,
          neighbors: Array.from( neighbors )
        } ) )
      } ) )
    }

    const encoder = new TextEncoder()
    return encoder.encode( JSON.stringify( data ) )
  }

  async deserialize( bytes: Uint8Array ): Promise<void> {
    const decoder = new TextDecoder()
    const data = JSON.parse( decoder.decode( bytes ) ) as {
      config: HNSWIndexConfig
      seed?: number
      prngState?: number
      entryPoint: string | null
      maxLevel: number
      nodes: Array<{
        id: string
        vector: number[]
        level: number
        connections: Array<{ level: number; neighbors: string[] }>
      }>
    }

    this._config = data.config
    this._seed = data.seed ?? this._seed
    // createPRNG sets its internal state directly from the argument, so
    // re-seeding with the persisted state resumes the exact sequence.
    this._prng = createPRNG( data.prngState ?? this._seed )
    this._entryPoint = data.entryPoint
    this._maxLevel = data.maxLevel
    this._nodes.clear()

    for( const nodeData of data.nodes ){
      const connections = new Map<number, Set<string>>()
      for( const conn of nodeData.connections )
        connections.set( conn.level, new Set( conn.neighbors ) )

      this._nodes.set( nodeData.id, {
        id: nodeData.id,
        vector: nodeData.vector,
        level: nodeData.level,
        connections
      } )
    }
  }

  // ── Private methods ───────────────────────────────────────

  private _randomLevel(): number {
    let level = 0
    while( this._prng.next() < 1 / this._config.hnswM! && level < 16 )
      level++

    return level
  }

  private _searchLayer(
    entry: HNSWNode,
    query: number[],
    level: number,
    ef: number
  ): HNSWNode[] {
    const visited = new Set<string>()
    const candidates: Array<{ node: HNSWNode; dist: number }> = []
    const results: Array<{ node: HNSWNode; dist: number }> = []

    const entryDist = this._distance( query, entry.vector )
    candidates.push( { node: entry, dist: entryDist } )
    results.push( { node: entry, dist: entryDist } )
    visited.add( entry.id )

    while( candidates.length > 0 ){
      candidates.sort( ( a, b ) => a.dist - b.dist )
      const best = candidates[0]!

      if( results.length >= ef && best.dist > results[results.length - 1]!.dist )
        break

      candidates.shift()

      // Expand the node we just popped, not the fixed entry node. Using
      // `entry` here collapsed the search into a single-hop scan of the
      // entry's immediate neighbourhood and never walked the graph, badly
      // degrading recall. Traverse `best`'s connections so the greedy walk
      // actually hops across the layer.
      const neighbors = best.node.connections.get( level ) ?? new Set()
      for( const neighborId of neighbors ){
        if( visited.has( neighborId ) ) continue

        const neighbor = this._nodes.get( neighborId )
        if( !neighbor ) continue

        visited.add( neighborId )
        const dist = this._distance( query, neighbor.vector )

        const candidate = { node: neighbor, dist }

        if( results.length < ef || dist < results[results.length - 1]!.dist ){
          candidates.push( candidate )
          results.push( candidate )
          results.sort( ( a, b ) => a.dist - b.dist )

          if( results.length > ef ) results.pop()
        }
      }
    }

    return results.map( r => r.node )
  }

  private _selectNeighbors( query: number[], candidates: HNSWNode[], m: number ): HNSWNode[] {
    const withDist = candidates.map( node => ( {
      node,
      dist: this._distance( query, node.vector )
    } ) )

    withDist.sort( ( a, b ) => a.dist - b.dist )

    return withDist.slice( 0, m ).map( r => r.node )
  }

  private _distance( a: number[], b: number[] ): number {
    switch( this._config.similarityMetric ){
      case 'cosine': return 1 - this._cosineSimilarity( a, b )
      case 'euclidean': return this._euclideanDistance( a, b )
      case 'dot': return -this._dotProduct( a, b )
      default: return 1 - this._cosineSimilarity( a, b )
    }
  }

  private _computeSimilarity( a: number[], b: number[] ): number {
    switch( this._config.similarityMetric ){
      case 'cosine': return this._cosineSimilarity( a, b )
      case 'euclidean': return 1 / ( 1 + this._euclideanDistance( a, b ) )
      case 'dot': return this._dotProduct( a, b )
      default: return this._cosineSimilarity( a, b )
    }
  }

  private _cosineSimilarity( a: number[], b: number[] ): number {
    let dot = 0, magA = 0, magB = 0
    for( let i = 0; i < a.length; i++ ){
      dot += a[i]! * b[i]!
      magA += a[i]! * a[i]!
      magB += b[i]! * b[i]!
    }

    return dot / ( Math.sqrt( magA ) * Math.sqrt( magB ) + 1e-8 )
  }

  private _euclideanDistance( a: number[], b: number[] ): number {
    let sum = 0
    for( let i = 0; i < a.length; i++ ){
      const diff = a[i]! - b[i]!
      sum += diff * diff
    }

    return Math.sqrt( sum )
  }

  private _dotProduct( a: number[], b: number[] ): number {
    let sum = 0
    for( let i = 0; i < a.length; i++ )
      sum += a[i]! * b[i]!

    return sum
  }
}

interface HNSWNode {
  id: string
  vector: number[]
  level: number
  connections: Map<number, Set<string>>
}
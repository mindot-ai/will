// ─────────────────────────────────────────────────────────────
// src/cognition/memory/vector.embedder.ts
// ─────────────────────────────────────────────────────────────

/**
 * Embedding provider interface — abstracts different embedding models.
 *
 * Supports:
 *   - Local models (via Transformers.js or Ollama)
 *   - Cloud providers (OpenAI, Anthropic, Cohere)
 *   - Mock embedder for testing/deterministic replay
 */

import type { TokenTracker } from '#cognition/utilities/token.tracker'
import type { LLMCallFunction } from '#cognition/utilities/token.tracker'
import { LLMSemaphore, withGate } from '#llm/gate'

/** Embedding is only ever a read or a write. */
export type EmbedFunction = Extract<LLMCallFunction, 'recall' | 'index'>

export interface EmbeddingProvider {
  readonly modelName: string
  readonly dimensions: number

  /** Generate embedding for a single piece of content. `fn` tags the call for
   *  cost attribution: 'recall' (query) vs 'index' (write). */
  embed( content: unknown, fn?: string ): Promise<number[]>

  /** Generate embeddings for multiple items (batched for efficiency). */
  embedBatch( contents: unknown[], fn?: string ): Promise<number[][]>

  /** Check if two embeddings are semantically equivalent (for replay validation) */
  areEquivalent( embedding1: number[], embedding2: number[], tolerance?: number ): boolean
}

/**
 * OpenAI-compatible embedder (works with OpenAI, Azure, LocalAI, Ollama)
 */
export class OpenAICompatibleEmbedder implements EmbeddingProvider {
  readonly modelName: string
  readonly dimensions: number

  private _apiUrl: string
  private _apiKey: string | null
  private _maxConcurrency: number
  private _timeoutMs: number
  private _tokenTracker: TokenTracker | null
  /**
   * Own gate — the same LLMSemaphore the LLM calls use, on a separate instance so
   * embeddings and reasoning do not compete for one another's slots. It bounds the
   * fan-out that produced the 10.7s tail, and `withGate` additionally retries a 429
   * with backoff, which a bare `embed()` previously surfaced as a hard failure.
   */
  private _gate: LLMSemaphore

  constructor( config: {
    modelName: string
    dimensions: number
    apiUrl: string
    apiKey?: string | null
    /**
     * Max embedding requests in flight at once — across ALL callers, not just one
     * embedBatch(). Default 4, chosen from measured provider behaviour rather than
     * taste: gemini-embedding-001 answers a lone request in ~1.1s, but queues hard
     * under fan-out — at 8 in flight the slowest three took 10.7s (all HTTP 200, no
     * 429, simply serialized). That tail is what made recall exceed its 5s budget
     * and return "no recall" while a mind with six live facets was asking.
     */
    maxConcurrency?: number
    /** Per-request timeout in ms before the connection is aborted. Default 30s. */
    timeoutMs?: number
    /**
     * Per-Will token tracker. When provided, each embedding call records its
     * input-token usage under the 'embedding' category so memory-vector spend is
     * visible alongside LLM spend instead of being a silent cost leak.
     */
    tokenTracker?: TokenTracker | null
  } ){
    this.modelName = config.modelName
    this.dimensions = config.dimensions
    this._apiUrl = config.apiUrl
    this._apiKey = config.apiKey ?? null
    this._maxConcurrency = Math.max( 1, config.maxConcurrency ?? 4 )
    this._gate = new LLMSemaphore( this._maxConcurrency )
    this._timeoutMs = config.timeoutMs ?? 30_000
    this._tokenTracker = config.tokenTracker ?? null
  }

  /**
   * Embed one item, gated. Every caller funnels through here — a facet building a
   * prompt, the master recalling, the consolidator indexing — so the gate is the
   * only place total in-flight fan-out is bounded. Waiting for a slot is strictly
   * better than the alternative it replaces: an ungated request that returns after
   * the recall budget has already expired is a request whose answer is thrown away.
   */
  async embed( content: unknown, fn: EmbedFunction = 'recall'): Promise<number[]> {
    return withGate( () => this._embedOnce( content, fn ), `embed:${ this.modelName }`, this._gate )
  }

  private async _embedOnce( content: unknown, fn: EmbedFunction ): Promise<number[]> {
    let response: Response
    try {
      response = await fetch(`${this._apiUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...( this._apiKey ? { 'Authorization': `Bearer ${this._apiKey}` } : {} )
        },
        body: JSON.stringify({
          model: this.modelName,
          input: typeof content === 'string' ? content : JSON.stringify( content )
        }),
        // Abort a hung connection instead of waiting forever (FN16).
        signal: AbortSignal.timeout( this._timeoutMs ),
      } )
    }
    catch( err ){
      // AbortSignal.timeout rejects with a DOMException named 'TimeoutError'.
      if( err instanceof Error && err.name === 'TimeoutError')
        throw new Error(`Embedding request timed out after ${this._timeoutMs}ms`)
      throw err
    }

    if( !response.ok )
      throw new Error(`Embedding failed: ${response.status} ${response.statusText}`)

    const data = await response.json() as {
      data?:  Array<{ embedding?: number[] }>
      usage?: { prompt_tokens?: number; total_tokens?: number }
    }

    // Guard the response shape: the old `data.data[0]!.embedding` threw an
    // opaque TypeError on an empty/malformed body (FN16).
    const embedding = data?.data?.[ 0 ]?.embedding
    if( !Array.isArray( embedding ) || embedding.length === 0 )
      throw new Error(`Embedding response was empty or malformed for model ${this.modelName}`)

    // The configured width must match what the provider actually returns. This class
    // sends no `dimensions` param, so the index is sized from config alone — and a
    // wrong number does not fail, it silently builds an index that can never match.
    // Providers differ per model family and change defaults between versions, so the
    // number is checked against reality once rather than trusted. Failing here is safe:
    // indexing degrades to "deferred" and recall to "no recall", both already
    // best-effort, and the message carries the value to set.
    if( embedding.length !== this.dimensions )
      throw new Error(
        `Embedding width mismatch for ${ this.modelName }: provider returned ${ embedding.length } ` +
        `dimensions, index is configured for ${ this.dimensions }. ` +
        `Set WILL_EMBEDDING_DIMENSIONS=${ embedding.length } (and delete any existing ` +
        `vector_index built at the old width).`
      )

    // Meter embedding token usage (input-only — embeddings have no completion).
    // Recorded under the 'embedding' category so per-Will dashboards can split
    // memory-vector spend from LLM reasoning spend.
    const usedTok = data?.usage?.total_tokens ?? data?.usage?.prompt_tokens ?? 0
    if( usedTok > 0 ){
      this._tokenTracker?.recordUsage({
        model:            this.modelName,
        promptTokens:     usedTok,
        completionTokens: 0,
        totalTokens:      usedTok,
        category:         'embedding',
        attribute:        'memory',
        process:          'cog',        // background: no deliberation happens here
        function:         fn,           // 'recall' (query) | 'index' (write)
        scope:            this.modelName,
        tick:             0,
        latencyMs:        0,
      })
    }

    return embedding
  }

  async embedBatch( contents: unknown[], fn: EmbedFunction = 'index'): Promise<number[][]> {
    // Bounded fan-out: cap concurrent requests at _maxConcurrency instead of
    // firing all of them at once (FN16), while preserving input order.
    const results: number[][] = new Array( contents.length )
    let next = 0

    const worker = async (): Promise<void> => {
      for( let i = next++; i < contents.length; i = next++ )
        results[ i ] = await this.embed( contents[ i ], fn )
    }

    await Promise.all(
      Array.from( { length: Math.min( this._maxConcurrency, contents.length ) }, () => worker() )
    )

    return results
  }

  areEquivalent( embedding1: number[], embedding2: number[], tolerance: number = 1e-6 ): boolean {
    if( embedding1.length !== embedding2.length ) return false

    for( let i = 0; i < embedding1.length; i++ ){
      if( Math.abs( embedding1[i]! - embedding2[i]! ) > tolerance ) return false
    }
    return true
  }
}

/**
 * Deterministic mock embedder for testing and replay.
 * Uses content hashing to produce stable embeddings.
 */
export class MockEmbedder implements EmbeddingProvider {
  readonly modelName = 'mock'
  readonly dimensions = 128

  private _seed: number

  constructor( seed: number = 42 ){
    this._seed = seed
  }

  async embed( content: unknown, _fn: EmbedFunction = 'recall'): Promise<number[]> {
    const str = typeof content === 'string' ? content : JSON.stringify( content )
    const hash = this._hashString( str )
    const embedding: number[] = []

    let state = hash
    for( let i = 0; i < this.dimensions; i++ ){
      state = this._next( state )
      embedding.push( ( state % 200000 ) / 200000 - 1 )
    }

    return embedding
  }

  async embedBatch( contents: unknown[], fn: EmbedFunction = 'index'): Promise<number[][]> {
    return Promise.all( contents.map( c => this.embed( c, fn ) ) )
  }

  areEquivalent( embedding1: number[], embedding2: number[], tolerance: number = 1e-6 ): boolean {
    if( embedding1.length !== embedding2.length ) return false
    for( let i = 0; i < embedding1.length; i++ ){
      if( Math.abs( embedding1[i]! - embedding2[i]! ) > tolerance ) return false
    }
    return true
  }

  private _hashString( str: string ): number {
    let hash = 2166136261
    for( let i = 0; i < str.length; i++ ){
      hash ^= str.charCodeAt( i )
      hash = Math.imul( hash, 16777619 )
    }
    return hash >>> 0
  }

  private _next( state: number ): number {
    state = Math.imul( state, 1103515245 ) + 12345
    return state >>> 0
  }
}
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

  constructor( config: {
    modelName: string
    dimensions: number
    apiUrl: string
    apiKey?: string | null
    /** Max embedding requests in flight at once for embedBatch(). Default 8. */
    maxConcurrency?: number
    /** @deprecated use maxConcurrency — kept as its fallback for back-compat. */
    batchSize?: number
    /** Per-request timeout in ms before the connection is aborted. Default 30s. */
    timeoutMs?: number
    /**
     * Per-Will token tracker. When provided, each embedding call records its
     * input-token usage under the 'embedding' category so memory-vector spend is
     * visible alongside LLM spend instead of being a silent COGS leak.
     */
    tokenTracker?: TokenTracker | null
  } ){
    this.modelName = config.modelName
    this.dimensions = config.dimensions
    this._apiUrl = config.apiUrl
    this._apiKey = config.apiKey ?? null
    this._maxConcurrency = Math.max( 1, config.maxConcurrency ?? config.batchSize ?? 8 )
    this._timeoutMs = config.timeoutMs ?? 30_000
    this._tokenTracker = config.tokenTracker ?? null
  }

  async embed( content: unknown, fn: string = 'recall' ): Promise<number[]> {
    let response: Response
    try {
      response = await fetch( `${this._apiUrl}/embeddings`, {
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
      if( err instanceof Error && err.name === 'TimeoutError' )
        throw new Error( `Embedding request timed out after ${this._timeoutMs}ms` )
      throw err
    }

    if( !response.ok )
      throw new Error( `Embedding failed: ${response.status} ${response.statusText}` )

    const data = await response.json() as {
      data?:  Array<{ embedding?: number[] }>
      usage?: { prompt_tokens?: number; total_tokens?: number }
    }

    // Guard the response shape: the old `data.data[0]!.embedding` threw an
    // opaque TypeError on an empty/malformed body (FN16).
    const embedding = data?.data?.[ 0 ]?.embedding
    if( !Array.isArray( embedding ) || embedding.length === 0 )
      throw new Error( `Embedding response was empty or malformed for model ${this.modelName}` )

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
        function:         fn,           // 'recall' (query) | 'index' (write)
        scope:            this.modelName,
        tick:             0,
        latencyMs:        0,
      })
    }

    return embedding
  }

  async embedBatch( contents: unknown[], fn: string = 'index' ): Promise<number[][]> {
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

  async embed( content: unknown, _fn: string = 'recall' ): Promise<number[]> {
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

  async embedBatch( contents: unknown[], fn: string = 'index' ): Promise<number[][]> {
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
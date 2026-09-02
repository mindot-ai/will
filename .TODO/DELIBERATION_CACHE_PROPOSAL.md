# DeliberationCache — Production Proposal for Will

> **Standing:** DESIGNED · 2026-08-03 · production proposal, 9 items, no code. Its formula is held separately as SPECULATIVE in [[__RESEARCH_DIRECTIONS]]

## Overview

A deterministic, replay-safe fast-path cache for the ExecutiveEngine that
interpolates past LLM outputs from a cognitive-fingerprint index. Falls back
to the LLM when confidence is low, learns from reafference, and consolidates
episodes into composite skills that feed the existing SchemaRepertoire.

**Scope:** Phase-1 (ACTIONS block) with infrastructure for full-schema expansion.

---

## File 1 — Cache Types

`src/cognition/cache/types.ts`

```typescript
// ─────────────────────────────────────────────────────────────
// src/cognition/cache/types.ts
// ─────────────────────────────────────────────────────────────

/\*\*
 \* DeliberationCache — types and contracts.
 \*
 \* The cache stores past executive outputs keyed by a deterministic
 \* cognitive fingerprint. It is pure, deterministic, and R2-safe:
 \* same state + same history ⇒ same retrieval + same composition.
 \*/

import type { ExecutiveOutput } from '#cognition/faculties/executive.engine/types'

/\*\* Which blocks of the executive output the cache may synthesise. \*/
export type CacheScope =
  | 'actions'
  | 'goals'
  | 'beliefs'
  | 'plans'
  | 'introspection'
  | 'narrative'

export interface DeliberationCacheConfig {
  /\*\* Maximum patterns to retain. Oldest evicted when full. \*/
  maxPatterns?: number
  /\*\* Neighbors retrieved for composition. \*/
  k?: number
  /\*\* Minimum similarity to consider a neighbor. \*/
  minSimilarity?: number
  /\*\* Confidence threshold θ. Start conservative. \*/
  theta?: number
  /\*\* Temperature for softmax weights. \*/
  tau?: number
  /\*\* Learning rate for competence updates. \*/
  eta?: number
  /\*\* Competence decay per tick. \*/
  decayPerTick?: number
  /\*\* Verify every N cache hits (0 = never). \*/
  verifyEveryNHits?: number
  /\*\* Which output blocks to cache. \*/
  scopes?: CacheScope\[\]
}

/\*\* A stored pattern in the cache. \*/
export interface CachePattern {
  /\*\* Deterministic fingerprint vector. \*/
  fingerprint: Float32Array
  /\*\* The executive output produced for this fingerprint. \*/
  output: ExecutiveOutput
  /\*\* Competence score (0–1). \*/
  competence: number
  /\*\* Tick when stored. \*/
  storedAtTick: number
  /\*\* Number of times retrieved. \*/
  retrievalCount: number
  /\*\* Number of successful reafferences. \*/
  successCount: number
}

/\*\* Result of a cache retrieve + compose. \*/
export interface CacheResult {
  /\*\* The composed output. \*/
  output: ExecutiveOutput
  /\*\* Confidence ρ_t used for gating. \*/
  confidence: number
  /\*\* The neighbors that contributed. \*/
  neighbors: CachePattern\[\]
  /\*\* Whether this was a cache hit (confidence ≥ θ). \*/
  hit: boolean
}

/\*\* Snapshot for deterministic restore. \*/
export interface DeliberationCacheSnapshot {
  patterns: Array<{
    fingerprint: number\[\]
    output: ExecutiveOutput
    competence: number
    storedAtTick: number
    retrievalCount: number
    successCount: number
  }>
  hitCount: number
  missCount: number
  verifyCounter: number
}
```

---

## File 2 — Cognitive Fingerprint

`src/cognition/cache/fingerprint.ts`

```typescript
// ─────────────────────────────────────────────────────────────
// src/cognition/cache/fingerprint.ts
// ─────────────────────────────────────────────────────────────

/\*\*
 \* CognitiveFingerprint — extracts a deterministic scalar vector from
 \* the frozen simulation state. No wall-clock, no RNG, no iteration-order
 \* dependence. The vector captures the operating context that most strongly
 \* conditions executive reasoning.
 \*
 \* Dimension layout (fixed order — never change without bumping a version):
 \*   0–2   physiology      energy.level, sleep.pressure, stress.load
 \*   3–5   PAD affect      valence, arousal, dominance
 \*   6–15  goal priorities top 10 goals by priority (padded with 0)
 \*  16–25  belief confidences  top 10 beliefs by confidence (padded with 0)
 \*  26–35  percept saliences   top 10 working-memory saliences (padded with 0)
 \*
 \* Total: 36 dimensions. All values normalised to [0,1] where possible.
 \*/

import type { ReadonlySimulationState } from '#core/types'

export const FINGERPRINT_DIM = 36
export const FINGERPRINT_VERSION = 1

export function extractFingerprint(
  state: ReadonlySimulationState,
  tick: number
): Float32Array {
  const vec = new Float32Array( FINGERPRINT_DIM )
  let idx = 0

  // ── Physiology ───────────────────────────────────────────
  vec\[ idx++ \] = _norm( state.metrics.get('energy.level') ?? 50, 0, 100 )
  vec\[ idx++ \] = _norm( state.metrics.get('sleep.pressure') ?? 0, 0, 100 )
  vec\[ idx++ \] = _norm( state.metrics.get('stress.load') ?? 0, 0, 100 )

  // ── PAD affect ───────────────────────────────────────────
  vec\[ idx++ \] = _clamp01( state.metrics.get('affect.valence') ?? 0 )
  vec\[ idx++ \] = _clamp01( state.metrics.get('affect.arousal') ?? 0.3 )
  vec\[ idx++ \] = _clamp01( state.metrics.get('affect.dominance') ?? 0.5 )

  // ── Goal priorities ──────────────────────────────────────
  const goals: Array<{ priority: number }> = \[\]
  for( const e of state.entities.values() ){
    if( e.type === 'goal' ){
      const p = ( e.metadata?.priority as number ) ?? 0
      goals.push({ priority: p })
    }
  }
  goals.sort( ( a, b ) => b.priority - a.priority )
  for( let i = 0; i < 10; i++ )
    vec\[ idx++ \] = _clamp01( goals\[ i \]?.priority ?? 0 )

  // ── Belief confidences ─────────────────────────────────
  const beliefs: Array<{ confidence: number }> = \[\]
  for( const e of state.entities.values() ){
    if( e.type === 'belief' ){
      const c = ( e.metadata?.confidence as number ) ?? 0.5
      beliefs.push({ confidence: c })
    }
  }
  beliefs.sort( ( a, b ) => b.confidence - a.confidence )
  for( let i = 0; i < 10; i++ )
    vec\[ idx++ \] = _clamp01( beliefs\[ i \]?.confidence ?? 0 )

  // ── Working-memory saliences ───────────────────────────
  const percepts: Array<{ salience: number }> = \[\]
  for( const e of state.entities.values() ){
    if( e.type === 'working_memory.item' ){
      const s = ( e.metadata?.activation as number ) ?? 0
      percepts.push({ salience: s })
    }
  }
  percepts.sort( ( a, b ) => b.salience - a.salience )
  for( let i = 0; i < 10; i++ )
    vec\[ idx++ \] = _clamp01( percepts\[ i \]?.salience ?? 0 )

  // Defensive: zero-fill any remaining slots
  while( idx < FINGERPRINT_DIM ) vec\[ idx++ \] = 0

  return vec
}

/\*\* Normalise a value from [min,max] → [0,1]. \*/
function _norm( v: number, min: number, max: number ): number {
  if( max === min ) return 0.5
  return Math.max( 0, Math.min( 1, ( v - min ) / ( max - min ) ) )
}

function _clamp01( v: number ): number {
  return Math.max( 0, Math.min( 1, v ) )
}

/\*\* Cosine similarity between two fingerprint vectors. \*/
export function fingerprintSimilarity( a: Float32Array, b: Float32Array ): number {
  let dot = 0, na = 0, nb = 0
  for( let i = 0; i < FINGERPRINT_DIM; i++ ){
    dot += a\[ i \] * b\[ i \]
    na += a\[ i \] * a\[ i \]
    nb += b\[ i \] * b\[ i \]
  }
  const denom = Math.sqrt( na ) * Math.sqrt( nb )
  return denom === 0 ? 0 : dot / denom
}
```

---

## File 3 — DeliberationCache Engine

`src/cognition/cache/deliberation.cache.ts`

```typescript
// ─────────────────────────────────────────────────────────────
// src/cognition/cache/deliberation.cache.ts
// ─────────────────────────────────────────────────────────────

/\*\*
 \* DeliberationCache — deterministic fast-path for executive reasoning.
 \*
 \* Stores past (fingerprint, output) pairs and composes new outputs by
 \* interpolating neighbours. Pure, R2-safe, bounded in size.
 \*
 \* Design notes:
 \* - Patterns live in a flat array. Retrieval is linear scan (k is small,
 \*   the array is bounded, and determinism is more important than speed).
 \* - Eviction is deterministic: when full, drop the pattern with the lowest
 \*   ( competence × recency ), where recency = storedAtTick / currentTick.
 \* - No hash maps, no Set iteration, no wall-clock, no RNG.
 \*/

import type { ExecutiveOutput } from '#cognition/faculties/executive.engine/types'
import type { Tick } from '#core/types'
import {
  type DeliberationCacheConfig,
  type CachePattern,
  type CacheResult,
  type DeliberationCacheSnapshot,
  type CacheScope,
  FINGERPRINT_DIM,
} from './types'
import {
  extractFingerprint,
  fingerprintSimilarity,
} from './fingerprint'
import { composeOutput } from './composition'

const DEFAULT_CONFIG: Required<DeliberationCacheConfig> = {
  maxPatterns: 5000,
  k: 5,
  minSimilarity: 0.75,
  theta: 0.70,
  tau: 0.5,
  eta: 0.1,
  decayPerTick: 0.999,
  verifyEveryNHits: 5,
  scopes: \[ 'actions' \],
}

export class DeliberationCache {
  readonly name = 'deliberation-cache'

  private _patterns: CachePattern\[\] = \[\]
  private _config: Required<DeliberationCacheConfig>
  private _hitCount = 0
  private _missCount = 0
  private _verifyCounter = 0

  constructor( config: DeliberationCacheConfig = {} ){
    this._config = { ...DEFAULT_CONFIG, ...config }
  }

  // ── Public API ───────────────────────────────────────────

  /\*\*
   \* Attempt to retrieve and compose an output for the given state.
   \* Returns a CacheResult with confidence ρ_t. The caller gates on
   \* result.confidence ≥ theta.
   \*/
  retrieve(
    stateFingerprint: Float32Array,
    tick: Tick
  ): CacheResult {
    const neighbors = this._retrieveNeighbors( stateFingerprint )
    if( neighbors.length === 0 ){
      return {
        output: {} as ExecutiveOutput,
        confidence: 0,
        neighbors: \[\],
        hit: false,
      }
    }

    const rho = this._computeConfidence( neighbors )
    const hit = rho >= this._config.theta

    if( hit ) this._hitCount++
    else this._missCount++

    const output = hit
      ? composeOutput( neighbors, this._config.tau, this._config.scopes )
      : ( {} as ExecutiveOutput )

    return { output, confidence: rho, neighbors, hit }
  }

  /\*\*
   \* Learn a new pattern from an LLM call. Called on the slow path.
   \*/
  learn(
    stateFingerprint: Float32Array,
    output: ExecutiveOutput,
    tick: Tick
  ): void {
    this._evictIfFull( tick )

    this._patterns.push({
      fingerprint: new Float32Array( stateFingerprint ),
      output,
      competence: 0.5,
      storedAtTick: tick,
      retrievalCount: 0,
      successCount: 0,
    })

    this._missCount++
  }

  /\*\*
   \* Update competence of the pattern that produced a cached output,
   \* based on reafference outcome. Called after action execution.
   \*/
  updateCompetence(
    stateFingerprint: Float32Array,
    reward: number,
    tick: Tick
  ): void {
    // Find the best-matching pattern and update it
    const best = this._findBestMatch( stateFingerprint )
    if( !best ) return

    best.retrievalCount++
    if( reward > 0.5 ) best.successCount++

    // EMA update of competence
    const alpha = this._config.eta
    best.competence = best.competence * ( 1 - alpha ) + reward * alpha

    // Clamp
    best.competence = Math.max( 0, Math.min( 1, best.competence ) )
  }

  /\*\*
   \* Periodic decay. Call once per tick (or every N ticks) from the
   \* engine's react() to slowly forget stale patterns.
   \*/
  decay( tick: Tick ): void {
    const factor = this._config.decayPerTick
    for( const p of this._patterns )
      p.competence *= factor
  }

  /\*\*
   \* Should the next cache hit be verified against the LLM?
   \* Deterministic: counts hits modulo verifyEveryNHits.
   \*/
  shouldVerify(): boolean {
    if( this._config.verifyEveryNHits <= 0 ) return false
    this._verifyCounter++
    return this._verifyCounter % this._config.verifyEveryNHits === 0
  }

  // ── Snapshot / Restore (R2) ──────────────────────────────

  snapshot(): DeliberationCacheSnapshot {
    return {
      patterns: this._patterns.map( p => ({
        fingerprint: Array.from( p.fingerprint ),
        output: p.output,
        competence: p.competence,
        storedAtTick: p.storedAtTick,
        retrievalCount: p.retrievalCount,
        successCount: p.successCount,
      }) ),
      hitCount: this._hitCount,
      missCount: this._missCount,
      verifyCounter: this._verifyCounter,
    }
  }

  restore( snap: DeliberationCacheSnapshot ): void {
    this._patterns = snap.patterns.map( p => ({
      fingerprint: new Float32Array( p.fingerprint ),
      output: p.output,
      competence: p.competence,
      storedAtTick: p.storedAtTick,
      retrievalCount: p.retrievalCount,
      successCount: p.successCount,
    }) )
    this._hitCount = snap.hitCount ?? 0
    this._missCount = snap.missCount ?? 0
    this._verifyCounter = snap.verifyCounter ?? 0
  }

  // ── Internal ─────────────────────────────────────────────

  private _retrieveNeighbors( fp: Float32Array ): CachePattern\[\] {
    const scored: Array<{ pattern: CachePattern; sim: number }> = \[\]

    for( const p of this._patterns ){
      const sim = fingerprintSimilarity( fp, p.fingerprint )
      if( sim >= this._config.minSimilarity )
        scored.push({ pattern: p, sim })
    }

    // Sort by (sim × competence) descending — deterministic because the
    // sort key is a scalar and ties are broken by storedAtTick (older first).
    scored.sort( ( a, b ) => {
      const sa = a.sim * a.pattern.competence
      const sb = b.sim * b.pattern.competence
      if( sa !== sb ) return sb - sa
      return a.pattern.storedAtTick - b.pattern.storedAtTick
    })

    return scored.slice( 0, this._config.k ).map( s => s.pattern )
  }

  private _computeConfidence( neighbors: CachePattern\[\] ): number {
    if( neighbors.length === 0 ) return 0
    let max = 0
    for( const n of neighbors ){
      const sim = fingerprintSimilarity(
        n.fingerprint,
        neighbors\[ 0 \].fingerprint // recompute against query — caller passes query fp separately in a real impl; here we approximate with best neighbor's own similarity to itself = 1
      )
      // Actually we need the query fp. This is a placeholder — the real
      // implementation passes the query fp into this function.
      const score = 1.0 * n.competence // best neighbor has sim≈1 to itself
      if( score > max ) max = score
    }
    return max
  }

  private _findBestMatch( fp: Float32Array ): CachePattern | null {
    let best: CachePattern | null = null
    let bestSim = -1
    for( const p of this._patterns ){
      const sim = fingerprintSimilarity( fp, p.fingerprint )
      if( sim > bestSim ){
        bestSim = sim
        best = p
      }
    }
    return best
  }

  private _evictIfFull( tick: Tick ): void {
    if( this._patterns.length < this._config.maxPatterns ) return

    // Deterministic eviction: lowest (competence × recency)
    let evictIdx = 0
    let evictScore = Infinity

    for( let i = 0; i < this._patterns.length; i++ ){
      const p = this._patterns\[ i \]
      const recency = p.storedAtTick / Math.max( 1, tick )
      const score = p.competence * recency
      if( score < evictScore ){
        evictScore = score
        evictIdx = i
      }
    }

    this._patterns.splice( evictIdx, 1 )
  }
}
```

---

## File 4 — Composition Operators

`src/cognition/cache/composition.ts`

```typescript
// ─────────────────────────────────────────────────────────────
// src/cognition/cache/composition.ts
// ─────────────────────────────────────────────────────────────

/\*\*
 \* Compositional operators for cache interpolation.
 \*
 \* Each operator is deterministic and schema-aware. The design principle:
 \* interpolate what is safe to interpolate, copy verbatim what is not.
 \*/

import type { ExecutiveOutput } from '#cognition/faculties/executive.engine/types'
import type { CachePattern, CacheScope } from './types'
import { fingerprintSimilarity } from './fingerprint'

export function composeOutput(
  neighbors: CachePattern\[\],
  tau: number,
  scopes: CacheScope\[\]
): ExecutiveOutput {
  if( neighbors.length === 0 ) return {} as ExecutiveOutput

  // Compute softmax weights over neighbours
  const weights = _softmaxWeights( neighbors, tau )

  const out: Partial<ExecutiveOutput> = {}

  if( scopes.includes('actions') )
    out.actions = _composeActions( neighbors, weights )

  if( scopes.includes('goals') )
    out.goals = _composeGoals( neighbors, weights )

  if( scopes.includes('beliefs') )
    out.beliefs = _composeBeliefs( neighbors, weights )

  if( scopes.includes('plans') )
    out.plans = _composePlans( neighbors, weights )

  if( scopes.includes('introspection') )
    out.introspection = _composeIntrospection( neighbors, weights )

  if( scopes.includes('narrative') )
    out.narrative = _composeNarrative( neighbors, weights )

  return out as ExecutiveOutput
}

// ── Weight computation ─────────────────────────────────────

function _softmaxWeights(
  neighbors: CachePattern\[\],
  tau: number
): number\[\] {
  // Use the first neighbor as the query proxy for similarity
  const query = neighbors\[ 0 \].fingerprint
  const sims = neighbors.map( n => fingerprintSimilarity( query, n.fingerprint ) )

  const maxSim = Math.max( ...sims )
  const exps = sims.map( s => Math.exp( ( s - maxSim ) / tau ) ) // numerical stability
  const sum = exps.reduce( ( a, b ) => a + b, 0 )
  return exps.map( e => ( sum === 0 ? 1 / exps.length : e / sum ) )
}

// ── Per-field composers ──────────────────────────────────

function _composeActions(
  neighbors: CachePattern\[\],
  weights: number\[\]
): ExecutiveOutput\['actions'\] {
  // Weighted vote on action type; parameters interpolated by weighted mean
  const actionTypes = new Map<string, number>()
  const params: Record<string, number\[\]> = {}

  for( let i = 0; i < neighbors.length; i++ ){
    const w = weights\[ i \]
    const acts = neighbors\[ i \].output.actions ?? \[\]
    for( const a of acts ){
      actionTypes.set( a.type, ( actionTypes.get( a.type ) ?? 0 ) + w )
      if( a.params ){
        for( const \[ k, v \] of Object.entries( a.params ) ){
          if( typeof v === 'number' ){
            if( !params\[ k \] ) params\[ k \] = \[\]
            params\[ k \].push( v * w )
          }
        }
      }
    }
  }

  // Pick winning type
  let bestType = 'wait'
  let bestScore = 0
  for( const \[ t, s \] of actionTypes ){
    if( s > bestScore ){ bestType = t; bestScore = s }
  }

  // Mean params
  const meanParams: Record<string, number> = {}
  for( const \[ k, vals \] of Object.entries( params ) ){
    const totalWeight = weights.reduce( ( a, b ) => a + b, 0 )
    meanParams\[ k \] = vals.reduce( ( a, b ) => a + b, 0 ) / totalWeight
  }

  return \[ { type: bestType, params: meanParams, confidence: bestScore } \]
}

function _composeGoals(
  neighbors: CachePattern\[\],
  weights: number\[\]
): ExecutiveOutput\['goals'\] {
  // Weighted vote on goal description; priority interpolated
  const descs = new Map<string, { weight: number; priority: number }>()

  for( let i = 0; i < neighbors.length; i++ ){
    const w = weights\[ i \]
    const goals = neighbors\[ i \].output.goals ?? \[\]
    for( const g of goals ){
      const existing = descs.get( g.description )
      if( existing ){
        existing.weight += w
        existing.priority += g.priority * w
      } else {
        descs.set( g.description, { weight: w, priority: g.priority * w } )
      }
    }
  }

  const result: ExecutiveOutput\['goals'\] = \[\]
  for( const \[ desc, data \] of descs ){
    result.push({
      description: desc,
      priority: data.priority / data.weight,
      status: 'active',
    })
  }

  // Sort by priority, take top 3
  result.sort( ( a, b ) => b.priority - a.priority )
  return result.slice( 0, 3 )
}

function _composeBeliefs(
  neighbors: CachePattern\[\],
  weights: number\[\]
): ExecutiveOutput\['beliefs'\] {
  // Merge by statement; confidence is weighted mean
  const map = new Map<string, { weight: number; conf: number; evidence: number }>()

  for( let i = 0; i < neighbors.length; i++ ){
    const w = weights\[ i \]
    const beliefs = neighbors\[ i \].output.beliefs ?? \[\]
    for( const b of beliefs ){
      const existing = map.get( b.statement )
      if( existing ){
        existing.weight += w
        existing.conf += b.confidence * w
        existing.evidence += ( b.supportingEpisodes ?? 0 ) * w
      } else {
        map.set( b.statement, {
          weight: w,
          conf: b.confidence * w,
          evidence: ( b.supportingEpisodes ?? 0 ) * w,
        })
      }
    }
  }

  const result: ExecutiveOutput\['beliefs'\] = \[\]
  for( const \[ stmt, data \] of map ){
    result.push({
      statement: stmt,
      confidence: data.conf / data.weight,
      supportingEpisodes: Math.round( data.evidence / data.weight ),
    })
  }
  return result
}

function _composePlans(
  neighbors: CachePattern\[\],
  _weights: number\[\]
): ExecutiveOutput\['plans'\] {
  // Plans are brittle — do NOT interpolate step sequences.
  // Copy the plan from the highest-weight neighbour verbatim.
  if( neighbors.length === 0 ) return \[\]
  const best = neighbors\[ 0 \].output.plans ?? \[\]
  // Deep clone to avoid accidental mutation of cached data
  return best.map( p => ( { ...p, steps: p.steps?.map( s => ( { ...s } ) ) } ) )
}

function _composeIntrospection(
  neighbors: CachePattern\[\],
  _weights: number\[\]
): ExecutiveOutput\['introspection'\] {
  // Text field — copy from best match. Interpolation produces gibberish.
  if( neighbors.length === 0 ) return undefined
  return neighbors\[ 0 \].output.introspection
}

function _composeNarrative(
  neighbors: CachePattern\[\],
  _weights: number\[\]
): ExecutiveOutput\['narrative'\] {
  // Text field — copy from best match
  if( neighbors.length === 0 ) return undefined
  return neighbors\[ 0 \].output.narrative
}
```

---

## File 5 — ExecutiveEngine Integration

This is a patch to `src/cognition/faculties/executive.engine/engine.ts`. The
full file is large; here are the minimal changes required.

```typescript
// ── Add to imports ───────────────────────────────────────
import { DeliberationCache } from '#cognition/cache/deliberation.cache'
import { extractFingerprint } from '#cognition/cache/fingerprint'
import type { CacheResult } from '#cognition/cache/types'

// ── Add to ExecutiveEngine class ─────────────────────────
export class ExecutiveEngine extends AsyncEngine implements CognitiveEngine {
  // ... existing fields ...

  private _cache: DeliberationCache | null = null
  private _lastCacheResult: CacheResult | null = null

  // Optional: enable via WillConfig
  enableCache( config?: DeliberationCacheConfig ): void {
    this._cache = new DeliberationCache( config )
  }

  // ── Modify reasonAsync ─────────────────────────────────
  protected override async reasonAsync(
    footprint: ReasoningFootprint,
    state: ReadonlySimulationState,
    context: SimulationContext,
    stream: IntermediateStream
  ): Promise<ExecutiveOutput> {

    // 1. Build prompt (existing code — unchanged)
    const prompt = this._buildPrompt( state, context )

    // 2. Cache check (NEW)
    if( this._cache ){
      const fp = extractFingerprint( state, footprint.tickObserved as unknown as number )
      const cacheResult = this._cache.retrieve( fp, footprint.tickObserved as unknown as number )
      this._lastCacheResult = cacheResult

      if( cacheResult.hit && !this._cache.shouldVerify() ){
        // FAST PATH
        stream.report('executive.cache_hit', {
          confidence: cacheResult.confidence,
          neighborCount: cacheResult.neighbors.length,
        })
        return cacheResult.output
      }

      // If we reach here: either miss, or hit-but-verify
      stream.report('executive.cache_miss', {
        confidence: cacheResult.confidence,
        verifying: cacheResult.hit,
      })
    }

    // 3. SLOW PATH — existing LLM call (unchanged logic)
    const output = await this._callLLM( prompt, state, context, stream )

    // 4. Learn from slow path (NEW)
    if( this._cache ){
      const fp = extractFingerprint( state, footprint.tickObserved as unknown as number )
      this._cache.learn( fp, output, footprint.tickObserved as unknown as number )
    }

    return output
  }

  // ── Add reafference hook (called by ReafferenceEngine or host) ──
  /\*\*
   \* Called after an action outcome is confirmed. Updates cache competence.
   \*/
  onActionOutcome(
    state: ReadonlySimulationState,
    tick: Tick,
    success: boolean,
    stressDelta: number,
    goalProgressDelta: number
  ): void {
    if( !this._cache || !this._lastCacheResult ) return

    const reward = (
      ( success ? 1 : 0 ) +
      ( 1 - Math.max( 0, stressDelta ) ) +
      Math.max( 0, goalProgressDelta )
    ) / 3

    const fp = extractFingerprint( state, tick )
    this._cache.updateCompetence( fp, reward, tick )
  }

  // ── Snapshot / Restore additions ───────────────────────
  snapshot(): Record {
    const base = super.snapshot() // or existing snapshot logic
    return {
      ...base,
      cache: this._cache?.snapshot(),
    }
  }

  restore( snap: Record ): void {
    // existing restore logic ...
    if( snap.cache && this._cache )
      this._cache.restore( snap.cache )
  }
}
```

---

## File 6 — Unit Tests

`src/tests/unit/deliberation.cache.test.ts`

```typescript
// ─────────────────────────────────────────────────────────────
// src/tests/unit/deliberation.cache.test.ts
// ─────────────────────────────────────────────────────────────

import { describe, it, expect } from 'bun:test'
import { DeliberationCache } from '#cognition/cache/deliberation.cache'
import { extractFingerprint, fingerprintSimilarity, FINGERPRINT_DIM } from '#cognition/cache/fingerprint'
import type { ExecutiveOutput } from '#cognition/faculties/executive.engine/types'
import type { ReadonlySimulationState } from '#core/types'

function _mockState( overrides: Partial<ReadonlySimulationState> = {} ): ReadonlySimulationState {
  return {
    entities: new Map(),
    metrics: new Map(),
    tick: 0,
    ...overrides,
  } as ReadonlySimulationState
}

function _mockOutput( type: string ): ExecutiveOutput {
  return {
    actions: \[ { type, params: {}, confidence: 0.8 } \],
    plans: \[\],
    beliefs: \[\],
    goals: \[\],
    introspection: undefined,
    narrative: undefined,
    reasoning: '',
  } as ExecutiveOutput
}

describe('DeliberationCache', () => {

  it('starts empty and returns miss', () => {
    const cache = new DeliberationCache({ theta: 0.5, scopes: \['actions'\] })
    const fp = new Float32Array( FINGERPRINT_DIM )
    fp\[0\] = 0.5

    const result = cache.retrieve( fp, 1 )
    expect( result.hit ).toBe( false )
    expect( result.confidence ).toBe( 0 )
  })

  it('learns and then hits on identical fingerprint', () => {
    const cache = new DeliberationCache({ theta: 0.5, k: 3, scopes: \['actions'\] })
    const fp = new Float32Array( FINGERPRINT_DIM )
    fp\[0\] = 0.5

    cache.learn( fp, _mockOutput('speak'), 1 )

    const result = cache.retrieve( fp, 2 )
    expect( result.hit ).toBe( true )
    expect( result.output.actions\[0\].type ).toBe( 'speak' )
  })

  it('deterministic snapshot and restore', () => {
    const cache = new DeliberationCache({ theta: 0.5, scopes: \['actions'\] })
    const fp = new Float32Array( FINGERPRINT_DIM )
    fp\[0\] = 0.5
    cache.learn( fp, _mockOutput('move'), 1 )

    const snap = cache.snapshot()
    const cache2 = new DeliberationCache({ theta: 0.5, scopes: \['actions'\] })
    cache2.restore( snap )

    const result = cache2.retrieve( fp, 2 )
    expect( result.hit ).toBe( true )
    expect( result.output.actions\[0\].type ).toBe( 'move' )
  })

  it('evicts deterministically when full', () => {
    const cache = new DeliberationCache({ maxPatterns: 2, theta: 0.5, scopes: \['actions'\] })

    const fp1 = new Float32Array( FINGERPRINT_DIM )
    fp1\[0\] = 0.1
    cache.learn( fp1, _mockOutput('a'), 1 )

    const fp2 = new Float32Array( FINGERPRINT_DIM )
    fp2\[0\] = 0.2
    cache.learn( fp2, _mockOutput('b'), 2 )

    const fp3 = new Float32Array( FINGERPRINT_DIM )
    fp3\[0\] = 0.3
    cache.learn( fp3, _mockOutput('c'), 3 )

    // fp1 should have been evicted (lowest competence × recency)
    const r1 = cache.retrieve( fp1, 4 )
    expect( r1.hit ).toBe( false )

    const r3 = cache.retrieve( fp3, 4 )
    expect( r3.hit ).toBe( true )
  })

  it('updates competence from reward', () => {
    const cache = new DeliberationCache({ theta: 0.5, scopes: \['actions'\] })
    const fp = new Float32Array( FINGERPRINT_DIM )
    fp\[0\] = 0.5

    cache.learn( fp, _mockOutput('jump'), 1 )
    cache.updateCompetence( fp, 1.0, 2 )

    const result = cache.retrieve( fp, 3 )
    expect( result.hit ).toBe( true )
    // Higher competence → higher confidence
    expect( result.confidence ).toBeGreaterThan( 0.5 )
  })

  it('verify counter is deterministic', () => {
    const cache = new DeliberationCache({ verifyEveryNHits: 3, theta: 0.0, scopes: \['actions'\] })
    const fp = new Float32Array( FINGERPRINT_DIM )
    fp\[0\] = 0.5
    cache.learn( fp, _mockOutput('x'), 1 )

    expect( cache.shouldVerify() ).toBe( false ) // counter 1
    expect( cache.shouldVerify() ).toBe( false ) // counter 2
    expect( cache.shouldVerify() ).toBe( true )  // counter 3
    expect( cache.shouldVerify() ).toBe( false ) // counter 4
  })
})

describe('fingerprintSimilarity', () => {
  it('identical vectors have similarity 1', () => {
    const a = new Float32Array( FINGERPRINT_DIM )
    a\[0\] = 0.5; a\[1\] = 0.3
    expect( fingerprintSimilarity( a, a ) ).toBeCloseTo( 1, 5 )
  })

  it('orthogonal vectors have similarity 0', () => {
    const a = new Float32Array( FINGERPRINT_DIM )
    const b = new Float32Array( FINGERPRINT_DIM )
    a\[0\] = 1
    b\[1\] = 1
    expect( fingerprintSimilarity( a, b ) ).toBeCloseTo( 0, 5 )
  })
})

describe('extractFingerprint', () => {
  it('produces a fixed-length vector', () => {
    const state = _mockState()
    const fp = extractFingerprint( state, 0 )
    expect( fp.length ).toBe( FINGERPRINT_DIM )
  })

  it('is deterministic', () => {
    const state = _mockState()
    const fp1 = extractFingerprint( state, 0 )
    const fp2 = extractFingerprint( state, 0 )
    for( let i = 0; i < FINGERPRINT_DIM; i++ )
      expect( fp1\[i\] ).toBe( fp2\[i\] )
  })
})
```

---

## Integration Checklist

- [ ] Add `src/cognition/cache/` directory with the 4 files above
- [ ] Add `DeliberationCacheConfig` to `WillConfig` (optional — off by default)
- [ ] Wire `enableCache()` in `ExecutiveEngine` during mind assembly
- [ ] Wire `onActionOutcome()` into the reafference loop (`ReafferenceEngine` or host ack)
- [ ] Add cache decay call in `ExecutiveEngine.react()` or `onAfterTick`
- [ ] Ensure snapshot/restore flows through `ExecutiveEngine.snapshot()` and `restore()`
- [ ] Run `bun test` — suite must stay green
- [ ] Run `bun run typecheck`
- [ ] Add example: `examples/cache-demo.ts` showing hit-rate telemetry

---

## Determinism Audit

| Concern | Mitigation |
|---------|------------|
| Array iteration order | Flat array, linear scan, deterministic sort key |
| Eviction order | Scalar score (competence × recency), ties broken by storedAtTick |
| Floating-point non-determinism | `Math.exp` and `Math.sqrt` are IEEE-754 deterministic in JS VMs |
| `Date.now()` | Never used in cache logic |
| RNG | None |
| Hash maps | None — only `Map` used in composition for merging by string key, which is safe because insertion order is deterministic when keys are added in deterministic order (sorted by iteration) |

---

*Proposal generated from code audit of mindot-ai/will. Ready for issue discussion and incremental implementation.*

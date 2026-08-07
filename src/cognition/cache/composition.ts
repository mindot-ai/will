// ─────────────────────────────────────────────────────────────
// src/cognition/cache/composition.ts
// ─────────────────────────────────────────────────────────────

/**
 * Compositional operators for cache interpolation.
 *
 * Design principle (from the research sketch): interpolate what is safe to
 * interpolate, copy verbatim what is not. Executive actions carry free-text
 * fields (`reasoning`, `expectedOutcome`) that would turn to gibberish under
 * blending, so the ACTIONS block uses a weighted *vote* over action type and
 * then copies the winning neighbor's action objects verbatim. Numeric scalars
 * (goal priority, belief confidence) are the only fields we mean-blend.
 *
 * Every operator is deterministic: inputs arrive pre-sorted from the cache and
 * ties are resolved by neighbor order (already deterministic), never by hashing.
 */

import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import type { ScoredNeighbor, CacheScope } from './types'

/**
 * Compose a valid ExecutiveOutputFull from scored neighbors. `neighbors` must be
 * non-empty and ordered best-first (as the cache returns them). The three
 * required fields (actions, reasoning, confidence) are always populated.
 */
export function composeOutput(
  neighbors: ScoredNeighbor[],
  tau: number,
  scopes: CacheScope[],
): ExecutiveOutputFull {
  const weights = _softmaxWeights( neighbors, tau )

  // The best neighbor anchors required fields when a scope leaves them empty.
  const anchor = neighbors[ 0 ]!.pattern.output

  const out: ExecutiveOutputFull = {
    actions:    [],
    reasoning:  anchor.reasoning ?? '',
    confidence: anchor.confidence ?? 0.5,
  }

  if( scopes.includes('actions') ){
    const composed = _composeActions( neighbors, weights )
    out.actions    = composed.actions
    out.reasoning  = composed.reasoning
    out.confidence = composed.confidence
  } else {
    // Actions are required downstream — fall back to the anchor's verbatim actions.
    out.actions = _clone( anchor.actions ?? [] )
  }

  if( scopes.includes('goals') )
    out.newGoals = _composeGoals( neighbors, weights )

  if( scopes.includes('beliefs') )
    out.newBeliefs = _composeBeliefs( neighbors, weights )

  return out
}

// ── Weight computation ─────────────────────────────────────

function _softmaxWeights( neighbors: ScoredNeighbor[], tau: number ): number[] {
  const t = tau > 0 ? tau : 1e-6
  const sims = neighbors.map( n => n.similarity )
  const maxSim = Math.max( ...sims )
  const exps = sims.map( s => Math.exp( ( s - maxSim ) / t ) )  // shift for stability
  const sum = exps.reduce( ( a, b ) => a + b, 0 )
  return exps.map( e => ( sum === 0 ? 1 / exps.length : e / sum ) )
}

// ── ACTIONS: weighted type vote + verbatim copy ────────────

function _composeActions(
  neighbors: ScoredNeighbor[],
  weights: number[],
): { actions: ExecutiveOutputFull['actions']; reasoning: string; confidence: number } {
  // Vote on each neighbor's primary (first) action type.
  const typeWeight = new Map<string, number>()
  for( let i = 0; i < neighbors.length; i++ ){
    const acts = neighbors[ i ]!.pattern.output.actions ?? []
    const primary = acts[ 0 ]?.type
    if( primary === undefined ) continue
    typeWeight.set( primary, ( typeWeight.get( primary ) ?? 0 ) + ( weights[ i ] ?? 0 ) )
  }

  // Winning type — deterministic: highest weight, ties broken by neighbor order
  // (the first neighbor to reach the max keeps it, and neighbors are best-first).
  let winningType: string | null = null
  let bestWeight = -1
  for( let i = 0; i < neighbors.length; i++ ){
    const primary = neighbors[ i ]!.pattern.output.actions?.[ 0 ]?.type
    if( primary === undefined ) continue
    const w = typeWeight.get( primary ) ?? 0
    if( w > bestWeight ){ bestWeight = w; winningType = primary }
  }

  // Copy the full action list from the highest-weight neighbor whose primary
  // action type matches the winner — verbatim, so text fields stay coherent.
  let source = neighbors[ 0 ]!
  for( let i = 0; i < neighbors.length; i++ ){
    if( neighbors[ i ]!.pattern.output.actions?.[ 0 ]?.type === winningType ){
      source = neighbors[ i ]!
      break
    }
  }

  const src = source.pattern.output
  return {
    actions:    _clone( src.actions ?? [] ),
    reasoning:  src.reasoning ?? '',
    confidence: src.confidence ?? 0.5,
  }
}

// ── GOALS: merge by description, mean priority (Phase 2) ────

function _composeGoals(
  neighbors: ScoredNeighbor[],
  weights: number[],
): ExecutiveOutputFull['newGoals'] {
  type Agg = {
    weight: number
    priority: number
    tags: string[]
    completionType: string
    completionCondition?: string
    bestW: number
  }
  const byDesc = new Map<string, Agg>()

  for( let i = 0; i < neighbors.length; i++ ){
    const w = weights[ i ] ?? 0
    for( const g of neighbors[ i ]!.pattern.output.newGoals ?? [] ){
      const cur = byDesc.get( g.description )
      if( cur ){
        cur.weight += w
        cur.priority += g.priority * w
        if( w > cur.bestW ){
          cur.bestW = w
          cur.tags = g.tags
          cur.completionType = g.completionType
          cur.completionCondition = g.completionCondition
        }
      } else {
        byDesc.set( g.description, {
          weight: w,
          priority: g.priority * w,
          tags: g.tags,
          completionType: g.completionType,
          completionCondition: g.completionCondition,
          bestW: w,
        } )
      }
    }
  }

  const result: NonNullable<ExecutiveOutputFull['newGoals']> = []
  for( const [ description, a ] of byDesc ){
    result.push( {
      description,
      priority: a.weight === 0 ? 0 : a.priority / a.weight,
      tags: [ ...a.tags ],
      completionType: a.completionType,
      ...( a.completionCondition !== undefined ? { completionCondition: a.completionCondition } : {} ),
    } )
  }
  result.sort( ( x, y ) => y.priority - x.priority )
  return result.slice( 0, 3 )
}

// ── BELIEFS: merge by statement, mean confidence (Phase 3) ─

function _composeBeliefs(
  neighbors: ScoredNeighbor[],
  weights: number[],
): ExecutiveOutputFull['newBeliefs'] {
  type Agg = {
    weight: number
    confidence: number
    category: string
    evidence: 'single_observation' | 'recurring_pattern' | 'strong_pattern'
    tags: string[]
    bestW: number
  }
  const byStmt = new Map<string, Agg>()

  for( let i = 0; i < neighbors.length; i++ ){
    const w = weights[ i ] ?? 0
    for( const b of neighbors[ i ]!.pattern.output.newBeliefs ?? [] ){
      const cur = byStmt.get( b.statement )
      if( cur ){
        cur.weight += w
        cur.confidence += b.confidence * w
        if( w > cur.bestW ){
          cur.bestW = w
          cur.category = b.category
          cur.evidence = b.evidence
          cur.tags = b.tags
        }
      } else {
        byStmt.set( b.statement, {
          weight: w,
          confidence: b.confidence * w,
          category: b.category,
          evidence: b.evidence,
          tags: b.tags,
          bestW: w,
        } )
      }
    }
  }

  const result: NonNullable<ExecutiveOutputFull['newBeliefs']> = []
  for( const [ statement, a ] of byStmt ){
    result.push( {
      statement,
      category: a.category,
      confidence: a.weight === 0 ? 0 : a.confidence / a.weight,
      evidence: a.evidence,
      tags: [ ...a.tags ],
    } )
  }
  return result
}

// ── Deterministic deep clone for verbatim-copied blocks ────

function _clone<T>( v: T ): T {
  return JSON.parse( JSON.stringify( v ) ) as T
}

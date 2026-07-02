// ─────────────────────────────────────────────────────────────
// src/agency/selection.scoring.ts  —  the competition's activation function
// ─────────────────────────────────────────────────────────────
//
// A mind does not pick a tool off a menu; affordances *compete*, and the
// competition is biased by what the body needs, what it wants, what it has
// learned, and what it fears. This is the basal-ganglia Go/NoGo arithmetic,
// kept pure so it is trivially testable and replay-deterministic.
//
//   activation = goalRelevance + expectedReward + novelty + driveUrgency
//              + habitStrength·W                              (additive habit bonus)
//              + planBias·W                                   (top-down prior)
//              − cost − inhibition − risk
//
// The habit term is additive (per design decision): an overlearned schema wins
// cheaply AND lowers its own deliberation threshold (see selector.ts), which is
// how the instrumental→habitual gradient cashes out as falling LLM spend.
// ─────────────────────────────────────────────────────────────

import type { Affordance } from '#agency/types'
import type { ReadonlySimulationState } from '#core/types'

/** Bias signals assembled from live state + the cognitive bus each tick. */
export interface BiasContext {
  /** Entity ids that an active goal is directed at. */
  goalTargets:  ReadonlySet<string>
  /** Priority of the highest-priority active goal (0..1). */
  maxGoalPriority: number
  /** Homeostatic drive pressures, each 0..1 (0 = satisfied). */
  drives:       { energy: number; sleep: number; stress: number; social: number }
  /** Ambient threat 0..1. */
  threat:       number
  /** Global NoGo pressure 0..1 from the InhibitionController. */
  inhibition:   number
}

export interface ScoreWeights {
  goal:    number
  reward:  number
  novelty: number
  drive:   number
  habit:   number
  /** Top-down planning prior — how strongly an executing plan biases the competition. */
  plan:    number
  cost:    number
  inhib:   number
  risk:    number
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  goal:    0.30,
  reward:  0.25,
  novelty: 0.10,
  drive:   0.25,
  habit:   0.20,
  plan:    0.30,
  cost:    0.20,
  inhib:   0.30,
  risk:    0.20,
}

/**
 * Decision temperature for the entropy softmax. Activations live in a narrow
 * band (~0..1), so a low temperature is needed for a real activation gap to read
 * as a confident winner rather than near-uniform noise. Lower = sharper / more
 * decisive; this is the knob a future arousal signal would modulate.
 */
export const DEFAULT_TEMPERATURE = 0.15

/**
 * Active-goal targets → the highest priority directed at each entity. Relevance is
 * structural (target match), never lexical: a goal links to an entity EITHER via
 * its `targetEntityId`/`requestingEntityId` metadata OR via a `keid:<id>` tag —
 * the convention KnownEntityTracker uses for the curiosity goals it forms. Shared
 * by the synthesizer (to lift goal-relevant affordances at the attention cap) and
 * the selector (to score goalRelevance), so both stages see the same links.
 */
export function collectGoalTargets( state: ReadonlySimulationState ): Map<string, number> {
  const targets = new Map<string, number>()
  for( const e of state.entities.values() ){
    if( e.type !== 'goal' ) continue
    const m = e.metadata as Record<string, unknown> | undefined
    const status = typeof m?.['status'] === 'string' ? m['status'] : undefined
    if( status !== 'active' && status !== 'in_progress' ) continue
    const priority = typeof m?.['priority'] === 'number' ? m['priority'] as number : 0
    const link = ( id: unknown ): void => {
      if( typeof id !== 'string' || !id ) return
      targets.set( id, Math.max( targets.get( id ) ?? 0, priority ) )
    }
    link( m?.['targetEntityId'] )
    link( m?.['requestingEntityId'] )
    if( Array.isArray( m?.['tags'] ) )
      for( const t of m['tags'] as unknown[] )
        if( typeof t === 'string' && t.startsWith( 'keid:' ) ) link( t.slice( 5 ) )
  }
  return targets
}

/** Goal relevance: structural (target match), not lexical. 0 when the affordance has no goal-linked target. */
export function goalRelevance( a: Affordance, bias: BiasContext ): number {
  if( a.targetEntityId && bias.goalTargets.has( a.targetEntityId ) )
    return bias.maxGoalPriority
  return 0
}

/** Homeostatic urgency routed to the affordance by its schema tags. */
export function driveUrgency( a: Affordance, bias: BiasContext ): number {
  const t = a.tags
  if( t.includes( 'regulatory' ) || t.includes( 'self-care' ) || t.includes( 'rest' ) )
    return Math.max( bias.drives.energy, bias.drives.sleep )
  if( t.includes( 'social' ) )
    return bias.drives.social
  if( t.includes( 'self-protection' ) )
    return Math.max( bias.drives.stress, bias.threat )
  return 0
}

/** Curiosity pull toward the unpracticed — proxied by the inverse of habit until a novelty engine feeds in. */
export function novelty( a: Affordance ): number {
  return clamp01( 1 - a.habitStrength )
}

/** Risk from anticipated negative affect and ambient threat. */
export function risk( a: Affordance, bias: BiasContext ): number {
  return clamp01( Math.max( 0, -a.expectedValence ) * 0.5 + bias.threat * 0.5 )
}

/** Full competition activation for one affordance. */
export function scoreAffordance(
  a:    Affordance,
  bias: BiasContext,
  w:    ScoreWeights = DEFAULT_WEIGHTS,
): number {
  return (
      w.goal    * goalRelevance( a, bias )
    + w.reward  * a.expectedReward
    + w.novelty * novelty( a )
    + w.drive   * driveUrgency( a, bias )
    + w.habit   * a.habitStrength
    + w.plan    * ( a.planBias ?? 0 )
    - w.cost    * a.cost
    - w.inhib   * bias.inhibition
    - w.risk    * risk( a, bias )
  )
}

/**
 * Stakes of committing to `winner` — how consequential the leading choice is.
 * High stakes recruit deliberation even when the field is not ambiguous.
 */
export function stakes( winner: Affordance, bias: BiasContext ): number {
  // Consequence, not unfamiliarity: ambient threat and the affective charge of
  // the leading choice dominate. Novelty contributes only weakly — a brand-new
  // schema is novel (1) but that alone should not force the LLM on every action
  // before any habit has formed; curiosity already lives in the activation.
  return clamp01( Math.max(
    bias.threat,
    Math.abs( winner.expectedValence ),
    novelty( winner ) * 0.5,
  ) )
}

/**
 * Normalized competition entropy (0..1). 0 = a single dominant winner; 1 = a
 * flat field with no clear choice. Softmax over activations, Shannon-normalized
 * by log(n). This is the ambiguity signal that recruits the executive.
 */
export function competitionEntropy(
  activations: number[],
  temperature: number = DEFAULT_TEMPERATURE,
): number {
  const n = activations.length
  if( n <= 1 ) return 0

  const t    = temperature > 0 ? temperature : DEFAULT_TEMPERATURE
  const max  = Math.max( ...activations )
  const exps = activations.map( a => Math.exp( ( a - max ) / t ) )
  const sum  = exps.reduce( ( s, e ) => s + e, 0 )
  if( sum === 0 ) return 1

  let h = 0
  for( const e of exps ){
    const p = e / sum
    if( p > 0 ) h -= p * Math.log( p )
  }
  return clamp01( h / Math.log( n ) )
}

function clamp01( n: number ): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

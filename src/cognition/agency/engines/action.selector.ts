// ─────────────────────────────────────────────────────────────
// src/agency/action.selector.ts  —  the biased, gated competition
// ─────────────────────────────────────────────────────────────
//
// The ActionSelector runs every tick with no LLM. It reads the affordance field
// the synthesizer wrote, assembles the bias signals the affective / drive /
// inhibition engines already expose, and runs a soft winner-take-all (see
// selection.scoring.ts). The winner is committed as an `agency.intent` for 
// the executor.
//
// System 1 is the default: the substrate selects and commits on its own. The
// executive (System 2, the LLM) is recruited only when the choice is genuinely
// uncertain or consequential — `deliberate` is set when competition entropy or
// stakes exceed threshold. Per design, an overlearned schema both wins more
// cheaply (additive habit bonus in scoring) AND raises its own deliberation
// thresholds (habit relief below), so proceduralized actions skip the LLM —
// the instrumental→habitual gradient cashing out as falling inference spend.
//
// The committed intent always carries the `deliberate` flag, so a tier without
// an executive still acts on the substrate's best guess; when an executive is
// present it may revise a deliberate intent before the executor runs next tick.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type {
  Duration, Tick, SimulationContext,
  ReadonlySimulationState, StateCommands, EntityInput,
} from '#core/types'
import type { CognitiveBus } from '#cognition/bus'
import type { CognitiveEngine, EngineResult } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { Affordance, AffordanceSource, ScoredAffordance } from '#agency/types'
import {
  scoreAffordance, competitionEntropy, stakes, collectGoalTargets,
  DEFAULT_WEIGHTS,
  type BiasContext, type ScoreWeights,
} from '#agency/selection.scoring'
import { readEffectiveParams, readPersonaPrior } from '#cognition/persona.prior'

/**
 * Activation margin (winner − runner-up) below which the choice is "contested" —
 * a genuine contender sits next to the winner, so System 2 is worth recruiting.
 * Uses the top-2 margin, NOT full-field entropy: a long tail of low-activation
 * options (e.g. the ever-present innate floor) must not by itself trigger
 * deliberation — only a real rival near the top does.
 */
const MARGIN_THRESHOLD = 0.06
/** Base stakes above which the choice is consequential enough to recruit the LLM. */
const BASE_STAKES_THRESHOLD = 0.60
/** How much a fully-proceduralized winner relaxes both gates (habit relief). */
const HABIT_RELIEF = 0.25

// ── Shared deliberativeness (R1) ───────────────────────────────
// The selector's deliberation gate and the executive's EffortGate are the two consumers
// of ONE deliberativeness disposition: the persona-prior on the executive's
// `deliberateThreshold` (analytical ↓ → deliberate more; decisiveness ↑ → less). Reading
// that same signal here keeps a Will from being impulsive in reasoning yet over-deliberate
// in action (or vice-versa). The signal is the deviation from baseline (the prior delta
// itself), so it is 0 — and these terms vanish — until a disposition actually develops.
// Each gate lives at its own native scale, so the deviation is mapped through a per-gate
// sensitivity (mirrors R2's "one disposition, two owners, native scales").
/** Margin-gate widening per unit deliberativeness (more deliberative ⇒ contest on larger margins). */
const DELIB_MARGIN_SENS = 0.15
/** Stakes-gate lowering per unit deliberativeness (more deliberative ⇒ deliberate at lower stakes). */
const DELIB_STAKES_SENS = 0.40

// ── Preemption (the "smarter serializer") ──────────────────────
/**
 * Switch-cost hysteresis: while an action is *awaiting*, the Will re-competes
 * every tick, but a challenger must beat the incumbent's activation by at least
 * this to interrupt it — preventing thrashing over marginally-better options.
 * The cost is scaled DOWN by the challenger's stakes, so a salient/urgent event
 * (a threat) faces almost no hysteresis and overrides immediately. This mirrors
 * basal-ganglia action selection: continuous, with a maintenance bias on the
 * ongoing action that salient interrupts can override.
 *
 * This is the *fallback* base only. The live base comes from
 * `engine-config-action-selector.switchCost` (base ⊕ persona-prior), so a
 * conscientious Will develops a higher switch resistance — the SAME disposition
 * the TaskSwitcher develops in attention space (R2: one switch-resistance trait,
 * two owners at their native scales). See `effectiveSwitchCost` in react().
 */
const BASE_SWITCH_COST = 0.15
/**
 * Per-focus-tick growth of switch resistance: the longer the Will has been
 * committed (shared `task_switch.current_focus_ticks`), the costlier to be pulled
 * off. Mirrors the TaskSwitcher's own internal `baseSwitchCost·(1+focusTicks·0.01)`
 * so both owners harden with focus identically — mechanism timing, not a
 * disposition, so it stays a module constant (not a persona-tunable param).
 */
const FOCUS_GAIN = 0.01
/** Ticks over which an awaiting action goes fully stale (matches the executor's
 *  await timeout) — a stale incumbent weakens and yields more readily. */
const AWAIT_STALE_TICKS = 15
/** How much a fully-stale awaiting incumbent's strength decays (0..1). */
const STALE_DECAY = 0.5

export class ActionSelector implements CognitiveEngine {
  readonly name = 'action-selector'

  private _bus: CognitiveBus | null = null
  private _lastEntropy    = 0
  private _lastDeliberate = false

  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  publishes(): CognitiveEventSchema[] {
    return [
      { type: 'agency.selection.made',      version: 1, validate: () => null },
      { type: 'agency.selection.ambiguous', version: 1, validate: () => null },
      { type: 'agency.action.preempted',    version: 1, validate: () => null },
    ]
  }
  subscribes(): string[] { return [] }
  onCognitiveEvent(): void { /* pull model — reads the field from frozen state */ }
  snapshot(): Record<string, unknown> {
    return { lastEntropy: this._lastEntropy, lastDeliberate: this._lastDeliberate }
  }

  async react(
    _delta:   Duration,
    tick:     Tick,
    state:    ReadonlySimulationState,
    _context: SimulationContext,
  ): Promise<EngineResult> {
    // ── Gather the field + classify the in-flight action ──────────
    // The Will acts serially (one body). But it is not frozen while busy: an
    // action merely *awaiting* a slow host/delivery can be PREEMPTED by a
    // sufficiently stronger / higher-stakes want (re-compete each tick, below). A
    // short-lived 'selected' (one tick) or a mid-composite 'expanding' is left to
    // finish — they resolve within a tick or carry their own progress.
    const eligible: Affordance[] = []
    const intents: Array<{ id: string; st: string; parentIntentId?: string; activation: number; schema: string; target: string; dispatchedAt: number }> = []
    const expandingParents = new Set<string>()

    for( const [ id, e ] of state.entities ){
      if( e.type === 'agency.intent'){
        const m  = ( e.metadata ?? {} ) as Record<string, unknown>
        const st = str( m['status'] ) ?? ''

        if( st === 'expanding') expandingParents.add( id )
          
        intents.push({
          id, st,
          parentIntentId: str( m['parentIntentId'] ),
          activation:     num( m['activation'], 0 ),
          schema:         str( m['schema'] )         ?? '',
          target:         str( m['targetEntityId'] ) ?? '',
          dispatchedAt:   num( m['dispatchedAt'], tick ),
        })

        continue
      }

      if( e.type !== 'affordance') continue

      const a = readAffordance( id, e.metadata )
      if( a.available ) eligible.push( a )
    }

    // Classify in-flight: 'awaiting' and an 'expanding' composite are PREEMPTIBLE;
    // a standalone 'selected', an orphan macro sub (its parent already cancelled), and
    // 'deliberating' BLOCK — let them finish (race-safe).
    let blocking = false
    let awaiting:  { id: string; activation: number; schema: string; target: string; dispatchedAt: number } | null = null
    let composite: { id: string; activation: number; schema: string } | null = null

    for( const it of intents ){
      if( it.st === 'deliberating') blocking = true
      else if( it.st === 'expanding') composite = { id: it.id, activation: it.activation, schema: it.schema }
      else if( it.st === 'awaiting') awaiting = { id: it.id, activation: it.activation, schema: it.schema, target: it.target, dispatchedAt: it.dispatchedAt }
      else if( it.st === 'selected'){
        const activeMacroSub = it.parentIntentId !== undefined && expandingParents.has( it.parentIntentId )
        if( !activeMacroSub ) blocking = true   // standalone or orphan sub → finish it
      }
    }

    const busy = ( n: number ): EngineResult => ({
      commands: {
        metrics: [
          [ 'agency.field.eligible', n ],
          [ 'agency.selection.busy', 1 ]
        ]
      }
    })

    if( blocking ) return busy( eligible.length )

    // Nothing afforded → idle (if an action is in flight, keep waiting).
    if( eligible.length === 0 )
      return {
        commands: {
          metrics: [
            [ 'agency.field.eligible', 0 ],
            [ 'agency.selection.busy',( awaiting || composite ) ? 1 : 0 ]
          ]
        }
      }

    // ── Run the competition over the current field ────────────────
    const bias   = buildBias( state )
    // Switch resistance = f(focus duration, conscientiousness): the persona-developed
    // base (engine-config-action-selector.switchCost ⊕ prior) hardened by how long the
    // Will has been committed (shared task_switch.current_focus_ticks). Computed once;
    // both preemption paths scale it DOWN by the challenger's stakes.
    const effSwitchCost = effectiveSwitchCost( state )
    // Competition weights (base ⊕ prior): a steadier Will weighs risk less (bolder), an
    // open Will weighs novelty more (curiosity pulls toward the unpracticed). Other weights
    // stay at DEFAULT_WEIGHTS — only the two with a clean trait owner are developable.
    const weights = effectiveWeights( state )
    const scored: ScoredAffordance[] = eligible
      .map( a => ({ affordance: a, activation: scoreAffordance( a, bias, weights ) }) )
      .sort( ( x, y ) => y.activation - x.activation )

    const winner = scored[0]
    if( !winner ) return busy( eligible.length )

    // ── Preempt a mid-composite routine (cancel-only) ─────────────
    // A strong/high-stakes challenger CANCELS the routine: delete the parent so the
    // executor's `_advance` guard (`if(!parent) return`) stops queueing sub-steps. We
    // do NOT commit the challenger this tick — that would race the executor's in-tick
    // macro-advance and double-enact. The current sub drains, then the next free tick
    // selects. (Immediate-switch composite preemption needs deferred macro-advance.)
    if( composite ){
      const different  = winner.affordance.schema !== composite.schema
      const switchCost = effSwitchCost * ( 1 - stakes( winner.affordance, bias ) )
      if( different && winner.activation > composite.activation + switchCost ){
        if( this._bus )
          try {
            this._bus.publish({
              type: 'agency.action.preempted',
              version: 1,
              sourceEngine: this.name,
              salience: 0.8,
              payload: {
                from: composite.schema,
                to: winner.affordance.schema,
                activation: winner.activation,
                tick
              }
            })
          }
          catch( err ){
            logger.warn(`[selector] preempt publish failed: ${ err instanceof Error ? err.message : String( err ) }`)
          }

        return {
          commands: {
            delete: [ composite.id ],
            metrics: [
              [ 'agency.field.eligible', eligible.length ],
              [ 'agency.selection.busy', 1 ],
              [ 'agency.selection.preempted', 1 ]
            ]
          }
        }
      }

      return busy( eligible.length )   // routine continues
    }

    // ── Preempt an awaiting action (commit the challenger) ────────
    // The incumbent carries a switch-cost bonus (hysteresis); a high-stakes challenger
    // faces almost none, so salient events interrupt. Deleting an 'awaiting' intent is
    // race-free: the executor never enacts it (only times it out at 15 ticks).
    let preemptDelete: string | undefined
    let preemptedFrom: string | undefined
    if( awaiting ){
      const sameAction = winner.affordance.schema === awaiting.schema && ( winner.affordance.targetEntityId ?? '') === awaiting.target
      if( sameAction ) return busy( eligible.length )   // field still favours what we await

      const staleness         = Math.min( 1, ( tick - awaiting.dispatchedAt ) / AWAIT_STALE_TICKS )
      const incumbentStrength = awaiting.activation * ( 1 - staleness * STALE_DECAY )
      const switchCost        = effSwitchCost * ( 1 - stakes( winner.affordance, bias ) )

      if( winner.activation <= incumbentStrength + switchCost )
        return busy( eligible.length )   // not worth interrupting — keep waiting

      preemptDelete = awaiting.id        // PREEMPT — fall through and commit the challenger
      preemptedFrom = awaiting.schema
    }

    // ── Commit the winner (fresh selection or preempting challenger) ──
    const entropy = competitionEntropy( scored.map( s => s.activation ) )   // telemetry only
    const second  = scored[1]?.activation
    const margin  = second !== undefined ? winner.activation - second : 1
    const stk     = stakes( winner.affordance, bias )
    const habit   = winner.affordance.habitStrength
    const relief  = Math.min( 1, habit ) * HABIT_RELIEF

    // Recruit System 2 when the top choice is genuinely contested (close runner-up)
    // or consequential. A strong habit relaxes both gates (the gradient); the shared
    // deliberativeness disposition (R1) shifts both gates the OTHER way for an analytical
    // Will — wider margin gate (contest sooner) and lower stakes gate (deliberate at lower
    // stakes). The two forces compose additively, each independent and bounded.
    const deliberativeness = -( readPersonaPrior( state, 'engine-config-executive')['deliberateThreshold'] ?? 0 )
    const marginGate = Math.max( 0, MARGIN_THRESHOLD - relief + deliberativeness * DELIB_MARGIN_SENS )
    const stakesGate = clamp01( BASE_STAKES_THRESHOLD + relief - deliberativeness * DELIB_STAKES_SENS )
    const deliberate = margin < marginGate || stk > stakesGate

    this._lastEntropy    = entropy
    this._lastDeliberate = deliberate

    const intent: EntityInput = {
      id:   `agency-intent-${ tick }`,
      type: 'agency.intent',
      metadata: {
        schema:          winner.affordance.schema,
        affordanceId:    winner.affordance.id,
        targetEntityId:  winner.affordance.targetEntityId,
        parameters:      winner.affordance.parameters,
        source:          winner.affordance.source,
        // Plan provenance (when a plan's frontier-step prior won the competition) —
        // flows through the executor's action.outcome so the PlanningEngine advances.
        ...( winner.affordance.planId ? { planId: winner.affordance.planId } : {} ),
        ...( winner.affordance.stepId ? { stepId: winner.affordance.stepId } : {} ),
        // forward-model priors carried so the executor can emit an efference copy
        // without depending on the (now-cleared) transient affordance entity.
        expectedReward:  winner.affordance.expectedReward,
        expectedValence: winner.affordance.expectedValence,
        habitStrength:   winner.affordance.habitStrength,
        activation:      winner.activation,
        entropy,
        stakes:          stk,
        deliberate,
        // Ambiguous/high-stakes → hand to the Deliberator (System 2), which resolves
        // it back to 'selected'. The executor ignores 'deliberating' intents. The
        // candidate set is carried so the Deliberator can choose without the field.
        status:          deliberate ? 'deliberating' : 'selected',
        candidates:      deliberate
          ? scored.slice( 0, 3 ).map( s => ({
              schema:         s.affordance.schema,
              targetEntityId: s.affordance.targetEntityId,
              parameters:     s.affordance.parameters,
              activation:     s.activation,
              // Carry the ability's meaning so the Deliberator weighs what each
              // option is FOR, not bare labels.
              ...( s.affordance.description ? { description: s.affordance.description } : {} ),
              // Channel B: flag a candidate that is an active plan's frontier step, so
              // the deliberation facet can own "this is my plan's next step" in-character.
              ...( s.affordance.source === 'plan' ? { fromPlan: true } : {} ),
            }) )
          : undefined,
        // Channel B: a preempting challenger that's ALSO deliberating carries what it
        // interrupted, so the deliberation facet can own the interruption in-character
        // ("I was about to X, but this pulled me away"). Only meaningful while deliberating.
        ...( preemptedFrom ? { preemptedFrom } : {} ),
        tick,
      },
    }

    if( this._bus ){
      try {
        this._bus.publish({
          type:         'agency.selection.made',
          version:      1,
          sourceEngine: this.name,
          salience:     0.6,
          payload:      { schema: winner.affordance.schema, activation: winner.activation, entropy, tick },
        })

        if( deliberate )
          this._bus.publish({
            type:         'agency.selection.ambiguous',
            version:      1,
            sourceEngine: this.name,
            salience:     0.75,
            payload:      {
              topSchemas: scored.slice( 0, 3 ).map( s => s.affordance.schema ),
              entropy, stakes: stk, tick,
            },
          })
          
        if( preemptedFrom )
          this._bus.publish({
            type:         'agency.action.preempted',
            version:      1,
            sourceEngine: this.name,
            salience:     0.8,
            payload:      { from: preemptedFrom, to: winner.affordance.schema, activation: winner.activation, tick },
          })
      }
      catch( err ){
        logger.warn(`[selector] bus publish failed: ${ err instanceof Error ? err.message : String( err ) }`)
      }
    }

    const commands: StateCommands = {
      set: [ intent ],
      ...( preemptDelete ? { delete: [ preemptDelete ] } : {} ),
      metrics: [
        [ 'agency.field.eligible',       eligible.length ],
        [ 'agency.selection.busy',       0 ],
        [ 'agency.selection.entropy',    entropy ],
        [ 'agency.selection.margin',     margin ],
        [ 'agency.selection.deliberate', deliberate ? 1 : 0 ],
        [ 'agency.selection.preempted',  preemptedFrom ? 1 : 0 ],
        [ 'agency.selection.activation', winner.activation ],
      ],
    }

    return { commands }
  }
}

// ─── switch resistance ───────────────────────────────────────────────────────

/**
 * Effective preemption hysteresis = persona-developed base ⊕ focus hardening.
 *
 * R2 reconciliation: the selector and the TaskSwitcher are the two owners of one
 * "switch resistance" disposition. They live at different scales (activation vs.
 * goal-priority), so the selector keeps its own `switchCost` base — but develops
 * it from the SAME conscientiousness driver and hardens it with the SAME focus
 * signal (`task_switch.current_focus_ticks`) using the SAME formula shape the
 * TaskSwitcher uses internally. One disposition, two owners, native scales.
 */
function effectiveSwitchCost( state: ReadonlySimulationState ): number {
  const params     = readEffectiveParams( state, 'engine-config-action-selector')
  const base       = num( params['switchCost'], BASE_SWITCH_COST )
  const focusTicks = metric( state, 'task_switch.current_focus_ticks', 0 )
  return base * ( 1 + focusTicks * FOCUS_GAIN )
}

/**
 * Competition weights = DEFAULT_WEIGHTS with the two trait-owned ones (risk, novelty)
 * overridden by their developed values (base ⊕ prior). Negative weights are clamped to
 * 0 (a prior can soften a weight to indifference but never invert its sign). The other
 * weights have no clean single-trait owner, so they stay fixed (see the TODO catalogue).
 */
function effectiveWeights( state: ReadonlySimulationState ): ScoreWeights {
  const p = readEffectiveParams( state, 'engine-config-action-selector')
  return {
    ...DEFAULT_WEIGHTS,
    risk:    Math.max( 0, num( p['riskWeight'],    DEFAULT_WEIGHTS.risk    ) ),
    novelty: Math.max( 0, num( p['noveltyWeight'], DEFAULT_WEIGHTS.novelty ) ),
  }
}

// ─── bias assembly ───────────────────────────────────────────────────────────

function buildBias( state: ReadonlySimulationState ): BiasContext {
  // Entity links recognized from `targetEntityId`/`requestingEntityId` metadata AND
  // `keid:` tags — shared with the synthesizer via collectGoalTargets so both stages
  // see the same goal→entity links (incl. KnownEntityTracker's curiosity goals).
  const goalTargets = new Set<string>( collectGoalTargets( state ).keys() )
  let   maxGoalPriority = 0

  for( const e of state.entities.values() ){
    if( e.type !== 'goal') continue
    const m      = e.metadata
    const status = str( m?.['status'] )
    if( status !== 'active' && status !== 'in_progress') continue
    maxGoalPriority = Math.max( maxGoalPriority, num( m?.['priority'], 0 ) )
  }

  return {
    goalTargets,
    maxGoalPriority: clamp01( maxGoalPriority ),
    drives: {
      energy: clamp01( ( 100 - metric( state, 'energy.level', 100 ) ) / 100 ),
      sleep:  clamp01( metric( state, 'sleep.pressure', 0 ) / 100 ),
      stress: clamp01( metric( state, 'stress.load',    0 ) / 100 ),
      social: clamp01( metric( state, 'drive.social',   0 ) ),
    },
    threat:     clamp01( metric( state, 'threat.level',     0 ) ),
    inhibition: clamp01( metric( state, 'inhibition.level', 0 ) ),
  }
}

// ─── entity decoding ─────────────────────────────────────────────────────────

function readAffordance( id: string, m: ReadonlyMap<string, unknown> | Record<string, unknown> | undefined ): Affordance {
  const meta = ( m ?? {} ) as Record<string, unknown>
  return {
    id,
    schema:          str( meta['schema'] ) ?? '',
    source:          ( str( meta['source'] ) as AffordanceSource ) ?? 'innate',
    parameters:      ( meta['parameters'] as Record<string, unknown> ) ?? {},
    targetEntityId:  str( meta['targetEntityId'] ),
    evokedBy:        str( meta['evokedBy'] ),
    expectedValence: num( meta['expectedValence'], 0 ),
    expectedReward:  num( meta['expectedReward'],  0 ),
    cost:            num( meta['cost'],            0 ),
    habitStrength:   num( meta['habitStrength'],   0 ),
    available:       meta['available'] === true,
    tags:            Array.isArray( meta['tags'] ) ? ( meta['tags'] as unknown[] ).filter( ( t ): t is string => typeof t === 'string') : [],
    planBias:        typeof meta['planBias'] === 'number' ? ( meta['planBias'] as number ) : undefined,
    planId:          str( meta['planId'] ),
    stepId:          str( meta['stepId'] ),
    tick:            num( meta['tick'], 0 ),
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function metric( state: ReadonlySimulationState, key: string, fallback: number ): number {
  return state.metrics.get( key ) ?? fallback
}
function num( v: unknown, fallback: number ): number {
  return typeof v === 'number' && Number.isFinite( v ) ? v : fallback
}
function str( v: unknown ): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function clamp01( n: number ): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

// ─────────────────────────────────────────────────────────────
// src/agency/reafference.engine.ts  —  prediction error → competence
// ─────────────────────────────────────────────────────────────
//
// Reafference is the loop that makes the Will grow. Each tick it reads the
// `agency.outcome` records the executor wrote, folds each into its schema's
// LearnedSkill (value, habit, prediction error, param priors — see
// repertoire.ts), and mirrors the updated skills into `agency.skill` state
// entities so they snapshot, surface in telemetry, and travel in the PMA. It
// likewise mirrors learned composite *templates* into `agency.schema` entities
// so the invented multi-step programs survive a restore (the executor resolves
// the template to expand a macro); restoreComposites() rehydrates them.
//
// The behavioural payoff closes the loop with selection: a schema that succeeds
// reliably AND predictably crosses the proceduralization threshold, which both
// raises its activation (additive habit bonus) and relaxes its deliberation
// threshold — so it stops recruiting the LLM. Inference spend falls as the Will
// learns. Disuse runs the forgetting curve in the other direction.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type {
  Duration, Tick, SimulationContext,
  ReadonlySimulationState, StateCommands, EntityInput,
} from '#core/types'
import type { LearnedSkill } from '#agency/types'
import type { CognitiveBus, CognitiveEvent } from '#cognition/bus'
import type { CognitiveEngine, EngineResult } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { SchemaRepertoire } from '#agency/schemas/repertoire'
import { schemaEntityId } from '#agency/schemas/repertoire'

const PROC_THRESHOLD = 0.60   // mirror of repertoire's threshold for the habitual-count metric

/**
 * EXAFFERENCE P5 — soft outcome quality for a purely *sensory* confirmation: the
 * world echoed our action back (a reafferent percept), but no host ack graded it.
 * A modest positive — "it manifested" — below a host ack's 0.8, enough to free the
 * awaiting intent and accrue competence instead of letting it time out as a failure.
 */
const SENSORY_SOFT_QUALITY = 0.6

export class ReafferenceEngine implements CognitiveEngine {
  readonly name = 'reafference'

  private _repertoire: SchemaRepertoire
  private _bus: CognitiveBus | null = null

  constructor( repertoire: SchemaRepertoire ){ this._repertoire = repertoire }

  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  publishes(): CognitiveEventSchema[] {
    return [
      { type: 'agency.skill.proceduralized', version: 1, validate: () => null },
      { type: 'agency.schema.discovered',    version: 1, validate: () => null },
      // Async-acked outcomes (host-ack reconciliation) flow through here, not the
      // executor — so for a plan-tagged reconciled outcome this engine emits the
      // action.outcome the PlanningEngine advances on. (The executor is the emitter
      // for sync/timeout outcomes; this is its async counterpart — one emitter each.)
      { type: 'action.outcome',              version: 1, validate: () => null },
    ]
  }
  /** Creation seam: register a composite proposed by the executive/deliberation facet. */
  subscribes(): string[] { return [ 'agency.composite.proposed' ] }
  onCognitiveEvent( e: CognitiveEvent ): void {
    if( e.type !== 'agency.composite.proposed') return
    const p = e.payload as { id?: string; name?: string; composedOf?: unknown; tags?: unknown; cost?: number }
    const id    = p.id ?? p.name
    const steps = Array.isArray( p.composedOf )
      ? ( p.composedOf as unknown[] ).filter( ( s ): s is string => typeof s === 'string')
      : []
    if( !id || steps.length < 2 ) return   // a composite needs a name + ≥2 sub-schemas

    this._repertoire.registerComposite({
      id, kind: 'composite', source: 'repertoire', binds: 'none',
      cost: typeof p.cost === 'number' ? p.cost : 0.1,
      composedOf: steps,
      tags: Array.isArray( p.tags ) ? ( p.tags as unknown[] ).filter( ( t ): t is string => typeof t === 'string') : [ 'composite' ],
    })
    logger.info(`[reafference] registered proposed composite "${ id }" (${ steps.join(' → ') })`)
  }
  snapshot(): Record<string, unknown> {
    return { skills: this._repertoire.skills().size }
  }

  async react(
    _delta:   Duration,
    tick:     Tick,
    state:    ReadonlySimulationState,
    _context: SimulationContext,
  ): Promise<EngineResult> {
    const set:     EntityInput[]            = []
    const del:     string[]                = []
    const metrics: Array<[ string, number ]> = []

    // ── 0. Gather outcomes: real ones from state + synthesized sensory ones ──
    // A `reafferent` percept (P2) carrying a `sourceIntentId` is the world echoing
    // our own action back. If that intent is still `awaiting` and no outcome graded
    // it this tick (a host ack / sync / timeout — those WIN), synthesize a soft
    // outcome so the skill learns and the intent is freed through the senses rather
    // than timing out as a failure (EXAFFERENCE P5). Ack-less awaiting intents only.
    const outcomes: Array<{ id: string; meta: Record<string, unknown>; fromState: boolean }> = []
    const gradedIntentIds = new Set<string>()
    for( const [ id, e ] of state.entities ){
      if( e.type !== 'agency.outcome') continue
      const m = ( e.metadata ?? {} ) as Record<string, unknown>
      outcomes.push({ id, meta: m, fromState: true })
      const iid = str( m['intentId'] ); if( iid ) gradedIntentIds.add( iid )
    }

    const awaiting = new Map<string, { schema: string; predictedReward: number; predictedValence: number }>()
    for( const [ id, e ] of state.entities ){
      if( e.type !== 'agency.intent' || str( e.metadata?.['status'] ) !== 'awaiting') continue
      const m = ( e.metadata ?? {} ) as Record<string, unknown>
      awaiting.set( id, {
        schema:           str( m['schema'] ) ?? '',
        predictedReward:  num( m['predictedReward'],  0.5 ),
        predictedValence: num( m['predictedValence'], 0 ),
      })
    }

    let sensory = 0
    const sensedIntentIds = new Set<string>()
    for( const [ , e ] of state.entities ){
      if( e.type !== 'percept') continue
      const m = ( e.metadata ?? {} ) as Record<string, unknown>
      if( str( m['provenance'] ) !== 'reafferent') continue
      const iid = str( m['sourceIntentId'] )
      if( !iid || gradedIntentIds.has( iid ) || sensedIntentIds.has( iid ) ) continue
      const aw = awaiting.get( iid )
      if( !aw || !aw.schema ) continue          // only ack-less awaiting intents
      sensedIntentIds.add( iid )
      sensory++
      outcomes.push({ id: `agency-outcome-${ tick }-${ iid }-sensory`, fromState: false, meta: {
        schema:           aw.schema,
        intentId:         iid,
        success:          true,
        outcomeQuality:   SENSORY_SOFT_QUALITY,
        valence:          aw.predictedValence,
        predictedReward:  aw.predictedReward,
        predictedValence: aw.predictedValence,
        surprise:         clamp01( Math.abs( aw.predictedReward - SENSORY_SOFT_QUALITY ) ),
        mode:             'external',
        reconciled:       true,
        sensory:          true,
        tick,
      } })
    }

    // ── 1. Fold each outcome into its skill ──────────────────────
    let updates    = 0
    let discovered = 0
    for( const { id, meta: m, fromState } of outcomes ){
      const schema = str( m['schema'] )
      if( !schema ){ if( fromState ) del.push( id ); continue }

      const { skill, proceduralized } = this._repertoire.recordOutcome({
        schema,
        success:         m['success'] === true,
        outcomeQuality:  num( m['outcomeQuality'],  0 ),
        predictedReward: num( m['predictedReward'], 0.5 ),
        params:          ( m['params'] as Record<string, unknown> ) ?? undefined,
        tick,
      })

      set.push( skillEntity( skill ) )
      if( fromState ) del.push( id )       // real outcome consumed (synthetic ones were never in state)
      // Host-ack reconciliation OR sensory confirmation: the outcome carries the
      // awaiting intent's id — free it so the serial Will can act again. The
      // executor's own sync outcomes already deleted their intent, so this is a
      // harmless no-op there.
      const intentId = str( m['intentId'] )
      if( intentId ) del.push( intentId )
      updates++

      // Plan advancement for the async path: a host-acked outcome that carries plan
      // provenance is the ONLY signal the PlanningEngine will get (the executor never
      // saw the ack — the intent was 'awaiting'). Emit the action.outcome it advances
      // on. Sync/timeout outcomes never carry planId here (the executor emitted their
      // action.outcome already), so this never double-advances.
      const planId = str( m['planId'] )
      if( planId )
        this._emitPlanOutcome( planId, str( m['stepId'] ), schema, m['success'] === true, num( m['outcomeQuality'], 0 ), num( m['surprise'], 0 ), tick )

      // Discovery: the first time the Will enacts a schema, it becomes a known part
      // of its repertoire (the new model's "discovered" — earned by doing, not catalogued).
      if( skill.enactments === 1 ){
        discovered++
        this._emitDiscovered( schema, tick )
      }

      if( proceduralized ){
        this._emitProceduralized( skill, tick )
        logger.info(`[reafference] "${ schema }" proceduralized (habit ${ skill.habitStrength.toFixed( 2 ) })`)
      }
    }

    // ── 2. Forgetting curve over the competence layer ────────────
    const dropped = this._repertoire.decay( tick )
    for( const id of dropped ){
      del.push(`agency-skill-${ id }`)
      del.push( schemaEntityId( id ) )   // composite mirror (harmless no-op for primitives)
    }

    // ── 3. Mirror learned composite templates ────────────────────
    // Skills become `agency.skill` (above); the invented composite *definitions*
    // must travel too, or a snapshot/restore brings back a skill whose schema is
    // gone and the executor can't expand it. Idempotent re-write each tick, like
    // GoalManager._persistGoals. Empty until a composite is actually learned.
    for( const e of this._repertoire.compositeEntities() ) set.push( e )

    // ── 4. Telemetry ─────────────────────────────────────────────
    const skills    = this._repertoire.skills()
    const habitual  = [ ...skills.values() ].filter( s => s.habitStrength >= PROC_THRESHOLD ).length
    metrics.push(
      [ 'agency.learning.updates', updates ],
      [ 'agency.discovered.count', discovered ],
      [ 'agency.skill.count',      skills.size ],
      [ 'agency.habitual.count',   habitual ],
      [ 'agency.sensory.confirmed', sensory ],
    )

    return { commands: { set, delete: del, metrics } }
  }

  private _emitProceduralized( skill: LearnedSkill, tick: Tick ): void {
    if( !this._bus ) return
    try {
      this._bus.publish({
        type: 'agency.skill.proceduralized', version: 1, sourceEngine: this.name,
        salience: 0.6,
        payload: { schema: skill.schema, habitStrength: skill.habitStrength, tick },
      })
    }
    catch( err ){ logger.warn(`[reafference] publish failed: ${ err instanceof Error ? err.message : String( err ) }`) }
  }

  /**
   * Emit the `action.outcome{planId,stepId}` for an async (host-acked) plan-step
   * enaction. Mirrors the executor's `_emitActionOutcome` payload so the
   * PlanningEngine's consumer can't tell which path produced it.
   */
  private _emitPlanOutcome(
    planId: string, stepId: string | undefined, schema: string,
    success: boolean, outcomeQuality: number, surprise: number, tick: Tick,
  ): void {
    if( !this._bus ) return
    try {
      this._bus.publish({
        type: 'action.outcome', version: 1, sourceEngine: this.name,
        salience: Math.min( 1, outcomeQuality * 0.6 ),
        payload: {
          actionType: schema, domain: schema, success, outcomeQuality, surprise,
          description: success ? 'The world confirmed the action.' : 'The world rejected the action.',
          planId,
          ...( stepId ? { stepId } : {} ),
          tick,
        },
      })
    }
    catch( err ){ logger.warn(`[reafference] plan outcome publish failed: ${ err instanceof Error ? err.message : String( err ) }`) }
  }

  private _emitDiscovered( schema: string, tick: Tick ): void {
    if( !this._bus ) return
    try {
      this._bus.publish({
        type: 'agency.schema.discovered', version: 1, sourceEngine: this.name,
        salience: 0.5, payload: { schema, tick },
      })
    }
    catch( err ){ logger.warn(`[reafference] discovered publish failed: ${ err instanceof Error ? err.message : String( err ) }`) }
  }
}

// ─── entity mirroring ────────────────────────────────────────────────────────

function skillEntity( s: LearnedSkill ): EntityInput {
  return {
    id: `agency-skill-${ s.schema }`,
    type: 'agency.skill',
    metadata: {
      schema:             s.schema,
      habitStrength:      s.habitStrength,
      valueEstimate:      s.valueEstimate,
      paramPriors:        s.paramPriors,
      enactments:         s.enactments,
      successes:          s.successes,
      avgPredictionError: s.avgPredictionError,
      lastEnactedTick:    s.lastEnactedTick,
    },
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function str( v: unknown ): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function num( v: unknown, fallback: number ): number {
  return typeof v === 'number' && Number.isFinite( v ) ? v : fallback
}
function clamp01( n: number ): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

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
import type { CognitiveBus, CognitiveEvent } from '#cognition/bus'
import type { CognitiveEngine, EngineResult } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { Affordance, AffordanceSource, ScoredAffordance } from '#agency/types'
import {
  scoreAffordance, competitionEntropy, stakes, collectGoalTargets,
  DEFAULT_WEIGHTS,
  type BiasContext, type ScoreWeights,
} from '#agency/selection.scoring'
import { readEffectiveParams, readPersonaPrior } from '#cognition/persona.prior'
import { RUPTURE_REVOKE_GATE, revocationEntity } from '#agency/revocation'
import { liveConsequences, matchConsequenceText } from '#agency/consequence'
import { asFinality } from '#stem/policy/arbiter'

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

// ── Exafferent rupture (EXAFFERENCE P3) ────────────────────────
/**
 * The world can revoke engagement, not only win it. `rupture` is a scalar in
 * [0,1] read pull-style from the exafferent percepts P2 tagged: when the world
 * moves on its own strongly enough to seize attention, it softens the Will's
 * commitment to what it was doing — "let go of waiting". Gate = WORKSPACE_THRESHOLD
 * so rupture ≈ "this percept would seize the global workspace". Because only
 * `provenance:'exafferent'` percepts count, the mind can never be ruptured by the
 * echo of its own action (P2 tagged those `reafferent` and attenuated them).
 */
const RUPTURE_SALIENCE_GATE = 0.4
/** Count exafferent percepts this fresh — matches the percept lifespan
 *  (Exteroception cleans up percepts older than 2 ticks), so a shock sustains
 *  rupture for exactly as long as its percept is alive, then decays. */
const RUPTURE_WINDOW_TICKS = 2
/** Per-tick mean-reversion of `situation.stability` back toward 1 (calm). */
const STABILITY_RECOVERY = 0.05
/** Snap-to-1 threshold: a settled mind stops re-writing the stability metric,
 *  so a never-ruptured run is byte-identical to pre-P3 (the metric is absent). */
const STABILITY_EPSILON = 1e-4
/** How many ticks a revocation stays "recent" enough to flavor the next
 *  deliberation formed in its wake (Channel-B hint); after this it's forgotten. */
const REVOKE_HINT_WINDOW = 8

export class ActionSelector implements CognitiveEngine {
  readonly name = 'action-selector'

  private _bus: CognitiveBus | null = null
  private _lastEntropy    = 0
  private _lastDeliberate = false
  // EXAFFERENCE P4 follow-up (Channel B): the schema we most recently revoked
  // under rupture, so the *next* deliberation formed in its wake can own the
  // interruption in-character ("something changed — I dropped what I was
  // weighing"). Telemetry-grade instance state, mirroring _lastEntropy.
  private _lastRevoked: { schema: string; tick: number } | null = null
  // ACP §2b: sense-channel percepts buffered off the bus for the next react's
  // rupture computation (they never become entities). Cross-tick ⇒ FN9.
  private _senseBuffer: Array<{ salience: number; text?: string }> = []

  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  publishes(): CognitiveEventSchema[] {
    return [
      { type: 'agency.selection.made',      version: 1, validate: () => null },
      { type: 'agency.selection.ambiguous', version: 1, validate: () => null },
      { type: 'agency.action.preempted',    version: 1, validate: () => null },
      { type: 'agency.situation.rupture',   version: 1, validate: () => null },
      { type: 'agency.commitment.revoked',  version: 1, validate: () => null },
    ]
  }
  subscribes(): string[] {
    return [
      'senses.*',
      // Registry #6 (ACP-P3): the model-error term — each carries its
      // engine's prediction-error salience, ALREADY precision-attenuated for
      // self-caused swings by the ACP-P2 consumers, so the echo guard
      // composes by construction: our own action's interoceptive wake
      // arrives below the rupture gate.
      'attention.state.changed', 'affect.state.changed', 'stress.state.changed',
    ]
  }
  /**
   * Mostly pull-model — but two afferent classes never become entities and
   * would leave rupture blind: sense-channel percepts
   * (ACTION_CONDITIONED_PREDICTION §2b) and the model-error state-change
   * events (registry #6). Buffer both (cross-tick: bus flush at T, consumed
   * by react at T+1 — FN9-snapshotted); the echo guard is applied at read
   * time for texts, and at the SOURCE for model errors (ACP-P2 precision).
   */
  onCognitiveEvent( e: CognitiveEvent ): void {
    const isSense = e.type.startsWith('senses.') && e.type.endsWith('.percept')
    const isModelError = e.type === 'attention.state.changed'
      || e.type === 'affect.state.changed' || e.type === 'stress.state.changed'
    if( !isSense && !isModelError ) return
    const p = e.payload as { content?: unknown } | undefined
    this._senseBuffer.push({
      salience: e.salience,
      ...( isSense && typeof p?.content === 'string' ? { text: p.content } : {} ),
    })
  }
  snapshot(): Record<string, unknown> {
    return {
      lastEntropy: this._lastEntropy, lastDeliberate: this._lastDeliberate,
      lastRevoked: this._lastRevoked, senseBuffer: this._senseBuffer,
    }
  }
  /** FN9: `_lastRevoked` has behavioral effect (the Channel-B `revokedBy` stamp),
   *  so a restored mind must carry it — a rupture-driven letting-go survives a
   *  snapshot boundary instead of silently losing its narrative thread. */
  restore( s: Record<string, unknown> ): void {
    if( typeof s['lastEntropy']    === 'number'  ) this._lastEntropy    = s['lastEntropy']
    if( typeof s['lastDeliberate'] === 'boolean' ) this._lastDeliberate = s['lastDeliberate']
    const lr = s['lastRevoked'] as { schema?: unknown; tick?: unknown } | null | undefined
    this._lastRevoked = lr && typeof lr === 'object' && typeof lr.schema === 'string' && typeof lr.tick === 'number'
      ? { schema: lr.schema, tick: lr.tick }
      : null
    const sb = s['senseBuffer']
    this._senseBuffer = Array.isArray( sb )
      ? ( sb as Array<{ salience?: unknown; text?: unknown }> )
          .filter( it => it && typeof it.salience === 'number' )
          .map( it => ({ salience: it.salience as number, ...( typeof it.text === 'string' ? { text: it.text } : {} ) }) )
      : []
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
    let deliberating: { id: string; schema: string } | null = null

    for( const it of intents ){
      if( it.st === 'deliberating'){ blocking = true; deliberating = { id: it.id, schema: it.schema } }
      else if( it.st === 'expanding') composite = { id: it.id, activation: it.activation, schema: it.schema }
      else if( it.st === 'awaiting') awaiting = { id: it.id, activation: it.activation, schema: it.schema, target: it.target, dispatchedAt: it.dispatchedAt }
      else if( it.st === 'selected'){
        const activeMacroSub = it.parentIntentId !== undefined && expandingParents.has( it.parentIntentId )
        if( !activeMacroSub ) blocking = true   // standalone or orphan sub → finish it
      }
    }

    // ── Exafferent rupture (EXAFFERENCE P3) ──────────────────────
    // How hard the world is pulling at us this tick (from P2's exafferent
    // percepts), and the slow-moving `situation.stability` it erodes. Both are
    // pure reads of frozen state; `stabMetrics` is empty on a never-ruptured run
    // so the quiet path stays byte-identical to pre-P3.
    const senseEvents = this._senseBuffer
    this._senseBuffer = []                           // consumed exactly once
    const rupture     = computeRupture( state, tick, senseEvents )
    const prevStab    = metric( state, 'situation.stability', 1 )
    const nextStabRaw = clamp01( prevStab + STABILITY_RECOVERY * ( 1 - prevStab ) - rupture )
    const nextStab    = 1 - nextStabRaw < STABILITY_EPSILON ? 1 : nextStabRaw
    const stabMetrics: Array<[ string, number ]> =
      ( rupture > 0 || prevStab < 1 ) ? [ [ 'situation.stability', nextStab ] ] : []

    if( rupture > 0 && this._bus ){
      try {
        this._bus.publish({
          type: 'agency.situation.rupture', version: 1, sourceEngine: this.name,
          salience: rupture, payload: { rupture, stability: nextStab, tick },
        })
      }
      catch( err ){ logger.warn(`[selector] rupture publish failed: ${ err instanceof Error ? err.message : String( err ) }`) }
    }

    const busy = ( n: number ): EngineResult => ({
      commands: {
        metrics: [
          [ 'agency.field.eligible', n ],
          [ 'agency.selection.busy', 1 ],
          ...stabMetrics,
        ]
      }
    })

    // ── Commitment revocation (EXAFFERENCE P4 · POLICY_REAFFERENCE P3) ──
    // A commitment still being weighed is let go for either of two DISTINCT
    // reasons: a hard exafferent rupture (the world surprised us), or a class
    // policy refusal of the very schema we're deliberating (the boundary just
    // declared it forbidden — deliberating our way into it is wasted). The two
    // never mix: the refusal is an outcome, not a percept, so it contributes
    // ZERO to the exafferent scalar. Either way we can't delete the
    // `deliberating` intent here (Deliberation runs after us and would resurrect
    // it set-after-delete), so we drop a tombstone the Deliberation engine +
    // Executor honor next tick. No successor is committed — the field re-forms.
    const policyRevoke = !!deliberating && refusedClassSchemas( state ).has( deliberating.schema )
    if( deliberating && ( rupture >= RUPTURE_REVOKE_GATE || policyRevoke ) ){
      const reason     = policyRevoke ? 'policy-refusal' : 'exafferent-rupture'
      const revRupture = policyRevoke ? Math.max( rupture, RUPTURE_REVOKE_GATE ) : rupture
      if( this._bus ){
        try {
          this._bus.publish({
            type: 'agency.commitment.revoked', version: 1, sourceEngine: this.name,
            salience: 0.85,
            payload: { from: deliberating.schema, reason, rupture: revRupture, tick },
          })
        }
        catch( err ){ logger.warn(`[selector] revoked publish failed: ${ err instanceof Error ? err.message : String( err ) }`) }
      }
      this._lastRevoked = { schema: deliberating.schema, tick }   // Channel-B: flavor the next deliberation
      return {
        commands: {
          set: [ revocationEntity( deliberating.id, deliberating.schema, revRupture, tick ) ],
          metrics: [
            [ 'agency.field.eligible', eligible.length ],
            [ 'agency.selection.busy', 1 ],
            [ 'agency.commitment.revoked', 1 ],
            ...( policyRevoke ? [ [ 'agency.policy.revoked', 1 ] as [ string, number ] ] : [] ),
            ...stabMetrics,
          ],
        },
      }
    }

    if( blocking ) return busy( eligible.length )

    // Nothing afforded → idle (if an action is in flight, keep waiting).
    if( eligible.length === 0 )
      return {
        commands: {
          metrics: [
            [ 'agency.field.eligible', 0 ],
            [ 'agency.selection.busy',( awaiting || composite ) ? 1 : 0 ],
            ...stabMetrics,
          ]
        }
      }

    // ── Run the competition over the current field ────────────────
    const bias   = buildBias( state )
    // Switch resistance = f(focus duration, conscientiousness): the persona-developed
    // base (engine-config-action-selector.switchCost ⊕ prior) hardened by how long the
    // Will has been committed (shared task_switch.current_focus_ticks). Computed once;
    // both preemption paths scale it DOWN by the challenger's stakes.
    // Rupture softens engagement on top of the persona/focus base: an unstable
    // situation makes the Will readier to be pulled off what it's doing. This is
    // ORTHOGONAL to the per-challenger stakes scaling applied at each preemption
    // site below (world-instability vs. challenger-quality) — the two compose,
    // they don't double-count.
    const effSwitchCost = effectiveSwitchCost( state ) * ( 1 - rupture )
    // Competition weights (base ⊕ prior): a steadier Will weighs risk less (bolder), an
    // open Will weighs novelty more (curiosity pulls toward the unpracticed). Other weights
    // stay at DEFAULT_WEIGHTS — only the two with a clean trait owner are developable.
    const weights = effectiveWeights( state )
    const scored: ScoredAffordance[] = eligible
      .map( a => ({ affordance: a, activation: scoreAffordance( a, bias, weights ) }) )
      .sort( ( x, y ) => y.activation - x.activation )

    const winner = scored[0]
    if( !winner ) return busy( eligible.length )

    // ── Preempt a mid-composite routine (IMMEDIATE SWITCH) ────────
    // A strong/high-stakes challenger cuts the routine off AND takes the body
    // the same tick. We cannot delete the parent here: the executor runs later
    // this tick off the pre-delete snapshot, and its macro-advance would
    // re-`set` the parent (resurrecting it, set-after-delete) and queue the next
    // sub as 'selected' — two selected intents next tick = double enaction.
    // So we tombstone the parent instead (the P4 mechanism) and commit the
    // challenger: next tick the executor honours the tombstone, dropping the
    // queued sub and the parent, and enacts the challenger alone. One body, one
    // action, one tick saved over the old cancel-only path.
    let compositeTombstone: string | undefined
    let compositeFrom:      string | undefined
    if( composite ){
      const different  = winner.affordance.schema !== composite.schema
      const switchCost = effSwitchCost * ( 1 - stakes( winner.affordance, bias ) )
      if( !different || winner.activation <= composite.activation + switchCost )
        return busy( eligible.length )   // routine continues

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

      compositeTombstone = composite.id
      compositeFrom      = composite.schema
      // fall through to commit the challenger
    }

    // ── Preempt an awaiting action (commit the challenger) ────────
    // The incumbent carries a switch-cost bonus (hysteresis); a high-stakes challenger
    // faces almost none, so salient events interrupt. Deleting an 'awaiting' intent is
    // race-free: the executor never enacts it (only times it out at 15 ticks).
    let preemptDelete: string | undefined
    let preemptedFrom: string | undefined = compositeFrom
    // A composite preemption already claimed the body: its tombstone cancels the
    // whole macro (parent + any sub, whatever the sub's status), so the awaiting
    // hysteresis below — which is about a *standalone* awaiting action — is skipped.
    if( awaiting && !compositeTombstone ){
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

    // Channel-B revocation hint: if we let go of a commitment under rupture in the
    // last few ticks and are now forming a fresh deliberation, tell it so — then
    // forget (consumed once). Stale hints are cleared without stamping.
    let revokedBy: string | undefined
    if( this._lastRevoked ){
      if( deliberate && tick - this._lastRevoked.tick <= REVOKE_HINT_WINDOW )
        revokedBy = this._lastRevoked.schema
      if( revokedBy || tick - this._lastRevoked.tick > REVOKE_HINT_WINDOW )
        this._lastRevoked = null
    }

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
        // Channel B: this deliberation forms in the wake of a rupture-driven
        // revocation — the facet can own "something changed, I let go of X".
        ...( revokedBy ? { revokedBy } : {} ),
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
      // A composite preemption rides along as a tombstone (never a delete — the
      // executor's in-tick macro-advance would resurrect the parent).
      set: compositeTombstone
        ? [ intent, revocationEntity( compositeTombstone, compositeFrom ?? '', rupture, tick ) ]
        : [ intent ],
      ...( preemptDelete ? { delete: [ preemptDelete ] } : {} ),
      metrics: [
        [ 'agency.field.eligible',       eligible.length ],
        [ 'agency.selection.busy',       0 ],
        [ 'agency.selection.entropy',    entropy ],
        [ 'agency.selection.margin',     margin ],
        [ 'agency.selection.deliberate', deliberate ? 1 : 0 ],
        [ 'agency.selection.preempted',  preemptedFrom ? 1 : 0 ],
        [ 'agency.selection.activation', winner.activation ],
        ...stabMetrics,
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
  // EXAFFERENCE P3 — focus only hardens under a stable situation. `situation.stability`
  // (absent ⇒ 1 ⇒ pre-P3 behavior) scales the focus-hardening term, so a Will in a
  // destabilized world can't cling to a long-held focus. The fast, same-tick softener
  // is `(1 - rupture)` applied at the call site; this is the slow, persistent one.
  const stability  = metric( state, 'situation.stability', 1 )
  return base * ( 1 + focusTicks * FOCUS_GAIN * stability )
}

/**
 * EXAFFERENCE P3 — the exafferent-rupture scalar. Max salience among the
 * `provenance:'exafferent'` percepts fresh within `RUPTURE_WINDOW_TICKS`,
 * mapped through `RUPTURE_SALIENCE_GATE` into [0,1]. Pure read of frozen state;
 * `reafferent` percepts (our own echo, P2) are excluded by construction, so the
 * mind is never ruptured by itself.
 */
function computeRupture(
  state: ReadonlySimulationState,
  tick: Tick,
  senseEvents: ReadonlyArray<{ salience: number; text?: string }> = [],
): number {
  let maxSalience = 0
  for( const e of state.entities.values() ){
    if( e.type !== 'percept') continue
    const m = e.metadata
    if( str( m?.['provenance'] ) !== 'exafferent') continue
    const pTick = num( m?.['tick'], -1 )
    if( pTick < 0 || tick - pTick > RUPTURE_WINDOW_TICKS ) continue
    const s = num( m?.['salience'], 0 )
    if( s > maxSalience ) maxSalience = s
  }

  // ACP §2b — buffered sense-channel percepts (bus-only; never entities). The
  // echo guard extends to this path: an event whose text matches a live
  // consequence descriptor is our own action coming back and cannot rupture.
  if( senseEvents.length > 0 ){
    const live = liveConsequences( state.entities, tick )
    for( const ev of senseEvents ){
      if( ev.text !== undefined && live.length > 0 && matchConsequenceText( live, ev.text ) ) continue
      if( ev.salience > maxSalience ) maxSalience = ev.salience
    }
  }

  if( maxSalience <= RUPTURE_SALIENCE_GATE ) return 0
  return clamp01( ( maxSalience - RUPTURE_SALIENCE_GATE ) / ( 1 - RUPTURE_SALIENCE_GATE ) )
}

/**
 * POLICY_REAFFERENCE P3 — schemas hit by a CLASS-final policy refusal visible in
 * frozen state this tick (a refused `agency.outcome` lives exactly one tick).
 *
 * A refusal is an `agency.outcome`, never a `percept`, so it can NEVER feed
 * computeRupture: the mind cannot rupture itself with its own boundary. This is
 * a SEPARATE, explicit trigger — "the boundary just declared this forbidden, let
 * go of any commitment I'm still weighing toward it" — distinct from a
 * world-surprise exafferent rupture, and it carries its own revocation reason.
 * Only `class` finality qualifies: an `instance` refusal means "not with those
 * parameters", not "never", so a still-deliberating attempt may yet succeed.
 */
function refusedClassSchemas( state: ReadonlySimulationState ): Set<string> {
  const out = new Set<string>()
  for( const e of state.entities.values() ){
    if( e.type !== 'agency.outcome') continue
    const m = e.metadata
    if( m?.['refused'] !== true || asFinality( m?.['finality'] ) !== 'class') continue
    const schema = str( m?.['schema'] )
    if( schema ) out.add( schema )
  }
  return out
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
    willBias:        typeof meta['willBias'] === 'number' ? ( meta['willBias'] as number ) : undefined,
    socialPrior:     typeof meta['socialPrior'] === 'number' ? ( meta['socialPrior'] as number ) : undefined,
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

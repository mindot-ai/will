// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/commands.ts
// ─────────────────────────────────────────────────────────────

import type { ReadonlySimulationState, StateCommands, ReasoningFootprint, EntityInput } from '#core/types'
import type { ExecutiveOutputFull } from '#faculties/executive.engine/types'
import type { CognitiveBus } from '#cognition/bus'
import type { ExecutiveSummarizer } from '#llm/summarizer'
import type { GoalManager } from '#faculties/goal.manager'
import type { GenerativeModel } from '#cognition/generative.model'
import type { SemanticIntegrator } from '#faculties/semantic.engine/integrator'

/** Maps the LLM's evidence enum to a numeric supportingEpisodes value for the belief store. */
export const EVIDENCE_TO_COUNT: Record<string, number> = {
  single_observation: 1,
  recurring_pattern:  3,
  strong_pattern:     8,
}

/** A manager-side mutation deferred until the tick is confirmed to commit (FN11). */
export type DeferredEffect = () => void

export interface BuiltCommands {
  /** Entity/metric mutations the orchestrator applies at commit. */
  commands: StateCommands
  /**
   * Manager-side writes (summarizer / goal / belief / effector registry + the
   * action-diversity ring buffer) that mirror `commands`. `buildStateCommands`
   * no longer runs these inline — the caller MUST invoke them only after the
   * tick has committed. A pre-commit validator can abort the tick
   * (orchestrator.ts:469-484), discarding `commands`; if the manager writes had
   * already landed during react(), state and managers would drift with no
   * compensation. Deferring keeps the dual-write atomic.
   */
  effects: DeferredEffect[]
}

export interface CommandDependencies {
  goalManager: GoalManager | null
  semanticIntegrator: SemanticIntegrator | null
  summarizer: ExecutiveSummarizer | null
  bus: CognitiveBus | null
  salience: GenerativeModel
  /**
   * Entity ID of the conversation participant whose message triggered the
   * current executive cycle (escalation context). Passed into addGoal() so
   * new goals carry a causal link back to their requester.
   */
  requestingEntityId?: string
  requestingThreadId?: string
}

/**
 * Convert an ExecutiveOutputFull into StateCommands plus a set of deferred
 * manager-side mutations (FN11).
 *
 * This function is now PURE: it performs no manager writes. It returns the
 * entity/metric `commands` AND an `effects` list mirroring them. The caller runs
 * `effects` only after the tick is confirmed to commit, so a pre-commit abort
 * can never leave the summarizer / goal manager / belief store / effector
 * registry ahead of discarded entity commands.
 */
export function buildStateCommands(
  output: ExecutiveOutputFull,
  footprint: ReasoningFootprint,
  state: ReadonlySimulationState,
  deps: CommandDependencies,
  recentActionTypes: string[]
): BuiltCommands {
  const commands: StateCommands = { set: [], delete: [], metrics: [] }
  const effects: DeferredEffect[] = []

  // ── Persist rolling summary ───────────────────────────────
  if( deps.summarizer ){
    const summarizer = deps.summarizer
    // Persist the *projected* post-record snapshot so the entity matches the
    // summarizer state the deferred record() produces on commit.
    commands.set!.push({
      id: 'executive-rolling-summary',
      type: 'executive.summary',
      metadata: summarizer.projectedSnapshot( output.reasoning )
    })

    effects.push( () => summarizer.record( output.reasoning ) )
  }

  // ── Decisions ──────────────────────────────────────────────
  // The agency pipeline is the sole action system: the executive deliberates (via
  // a facet) and biases the competition, but no longer emits parameterless
  // `actions[]` as decision.records. It still forms goals / beliefs / narrative.
  //
  // Ideomotor leg (AffordanceSource.ideomotor): the executive's imagined communicate
  // actions become `ideomotor.intent` entities the AffordanceSynthesizer surfaces as
  // competing reach-out affordances next tick — executive intention ENTERS the
  // competition, it does not bypass it. Refreshed each cycle.
  const ideo = buildIdeomotorIntents( output, state, footprint )
  commands.set!.push( ...ideo.set )
  commands.delete!.push( ...ideo.delete )

  // ── Plans ──────────────────────────────────────────────────
  // No entity write here: the PlanningEngine is the single ingest path for
  // `output.plans` (→ PlanStore lifecycle + persistence). The former raw
  // `plan-executive-<goal>-<tick>` records froze at status 'ready' forever,
  // piled up per re-authoring, and fed back into the executive's own
  // Active-Plans awareness as phantom drafts — encouraging yet another
  // re-authoring. (The PlanningEngine sweeps legacy ones on wake.)

  // ── Apply New Beliefs ──────────────────────────────────────
  if( output.newBeliefs && deps.semanticIntegrator ){
    const integrator = deps.semanticIntegrator
    for( let idx = 0; idx < output.newBeliefs.length; idx++ ){
      const nb = output.newBeliefs[ idx ]!
      const belief = {
        // FN12: deterministic id from the sim clock (tickObserved) + batch index,
        // not Date.now()+Math.random() — so the same seed+inputs reproduce the
        // same entity graph on replay.
        id: `belief-executive-${footprint.tickObserved}-${idx}`,
        statement: nb.statement,
        category: nb.category as any, // Belief['category'] — 'world_fact' | 'self_belief' | 'social_belief' | 'causal_rule' | 'pattern'
        confidence: nb.confidence,
        supportingEpisodes: EVIDENCE_TO_COUNT[ nb.evidence ] ?? 1,
        lastUpdatedAt: footprint.tickObserved,
        tags: nb.tags ?? []
      }

      effects.push( () => integrator.integrateExecutiveBelief( belief, footprint.tickObserved ) )

      commands.set!.push({
        id: belief.id,
        type: 'belief',
        metadata: {
          statement: belief.statement,
          category: belief.category,
          confidence: belief.confidence,
          supportingEpisodes: belief.supportingEpisodes,
          tags: belief.tags
        }
      })
    }
  }

  // ── Apply Known-Entity Updates (Phase 2.2 — conscious learning about others) ──
  // Learned facts become keid-tagged social beliefs (so they ride the episodic
  // consolidator + vector memory and surface in working memory — like any belief). The
  // identity/affective bits (name, felt valence) go to known.entity.tracker via an event,
  // keeping it the single writer of the ke-<keid> dossier.
  if( output.knownEntityUpdates && output.knownEntityUpdates.length > 0 ){
    const integrator = deps.semanticIntegrator
    const bus        = deps.bus
    output.knownEntityUpdates.forEach( ( u, ui ) => {
      if( !u.keid || u.keid === 'agent-self' ) return

      const facts = u.learned ?? []
      facts.forEach( ( fact, fi ) => {
        if( !fact || !integrator ) return
        const belief = {
          id:                 `belief-ke-${footprint.tickObserved}-${ui}-${fi}`,
          statement:          fact,
          category:           'social_belief' as const,
          confidence:         0.7,
          supportingEpisodes: 1,
          lastUpdatedAt:      footprint.tickObserved,
          tags:               [ 'social', 'known-entity', `keid:${u.keid}` ],
        }
        effects.push( () => integrator.integrateExecutiveBelief( belief, footprint.tickObserved ) )
        commands.set!.push({ id: belief.id, type: 'belief', metadata: {
          statement: belief.statement, category: belief.category, confidence: belief.confidence,
          supportingEpisodes: belief.supportingEpisodes, tags: belief.tags } })
      })

      if( bus && ( u.name || u.feeling != null ) )
        effects.push( () => bus.publish({
          type: 'known.entity.learned', version: 1, sourceEngine: 'executive',
          salience: 0.5, payload: { keid: u.keid, name: u.name, feeling: u.feeling },
        }) )
    })
  }

  // ── Apply Introspection ────────────────────────────────────
  if( output.introspection )
    commands.set!.push({
      id: `introspection-executive-${footprint.tickObserved}`,
      type: 'introspection',
      metadata: output.introspection
    })

  // ── Apply Narrative ────────────────────────────────────────
  if( output.narrative )
    commands.set!.push({
      id: `narrative-executive-${footprint.tickObserved}`,
      type: 'narrative_chapter',
      metadata: {
        narrative: output.narrative,
        themes: output.narrativeThemes ?? [],
        currentSelfView: output.currentSelfView ?? ''
      }
    })

  // ── Apply Goal Changes ─────────────────────────────────────
  if( output.newGoals && deps.goalManager ){
    const goalManager = deps.goalManager
    const requestingEntityId = deps.requestingEntityId
    const requestingThreadId = deps.requestingThreadId

    // If this output also contains conversation replies, auto-tag any new goals
    // with communication metadata so _nudgeActionGoals can match them.
    for( const goal of output.newGoals.slice( 0, 2 ) )
      effects.push( () => goalManager.addGoal(
        goal.description,
        goal.priority,
        goal.tags,
        undefined,
        undefined,
        goal.completionType as any,
        goal.completionCondition,
        undefined,             // id — auto-generated
        requestingEntityId,
        requestingThreadId
      ))
  }

  if( output.goalsToAbandon && deps.goalManager ){
    const goalManager = deps.goalManager
    for( const ga of output.goalsToAbandon )
      effects.push( () => goalManager.abandonGoal( ga.goalId, ga.reason ) )
  }

  if( output.goalsToReprioritize && deps.goalManager ){
    const goalManager = deps.goalManager
    for( const gr of output.goalsToReprioritize )
      effects.push( () => goalManager.updateGoalPriority( gr.goalId, gr.newPriority ) )
  }

  // Created effectors are owned by the agency repertoire now (skills proceduralize
  // from enaction); the executive no longer composes effectors in its output.

  // ── Apply Self-Observations ────────────────────────────────
  if( output.selfObservations )
    output.selfObservations.slice( 0, 5 ).forEach( ( obs, idx ) => {
      commands.set!.push({
        id: `self-obs-slot-${(footprint.tickObserved + idx) % 20}`,
        type: 'self_observation',
        metadata: { observation: obs, tick: footprint.tickObserved }
      })
    })

  // ── Metrics ────────────────────────────────────────────────
  commands.metrics!.push(
    ['executive.last_tick', footprint.tickObserved ],
    ['executive.action_count', output.actions.length ],
    ['executive.plan_count', output.plans?.length ?? 0 ],
    ['executive.belief_count', output.newBeliefs?.length ?? 0 ],
    ['cognitive.load', Math.min(1, output.actions.length / 5) ],
    ['executive.confidence', output.confidence ]
  )

  // Action diversity metric
  if( recentActionTypes.length > 0 ){
    const uniqueTypes = new Set( recentActionTypes ).size

    commands.metrics!.push([
      'executive.action_diversity',
      uniqueTypes / recentActionTypes.length
    ])
  }

  // ── Update action diversity ring buffer (deferred mutation) ─
  // The diversity metric above reads the pre-update buffer (unchanged
  // behaviour); the in-place mutation is deferred so an aborted tick's actions
  // don't pollute the next cycle's diversity calculation.
  effects.push( () => {
    for( const action of output.actions )
      recentActionTypes.push( action.type )

    if( recentActionTypes.length > 5 )
      recentActionTypes.splice( 0, recentActionTypes.length - 5 )
  })

  return { commands, effects }
}

/**
 * Publish cognitive events to the bus after reasoning completes.
 */
export function publishCognitiveEvents(
  output: ExecutiveOutputFull,
  footprint: ReasoningFootprint,
  bus: CognitiveBus | null,
  coherenceVersion: number,
  salience: GenerativeModel
): void {
  if( !bus ) return

  // interpretation.formed — always broadcast after each executive cycle
  bus.publish({
    type: 'executive.interpretation.formed',
    version: 1,
    sourceEngine: 'executive-engine',
    salience: 0.8,
    payload: {
      confidence: output.confidence,
      reasoning: output.reasoning.slice( 0, 400 ),
      actionTypes: output.actions.map( a => a.type ),
      tick: footprint.tickObserved,
      coherenceVersion
    }
  })

  // decision.rationale — for each action decided
  for( const action of output.actions )
    bus.publish({
      type: 'executive.decision.rationale',
      version: 1,
      sourceEngine: 'executive-engine',
      salience: 0.6,
      payload: {
        actionType: action.type,
        confidence: output.confidence,
        reasoning: action.reasoning.slice( 0, 200 ),
        tick: footprint.tickObserved
      }
    })

  // goal.proposed — when executive proposes new goals
  if( output.newGoals?.length )
    bus.publish({
      type: 'executive.goal.proposed',
      version: 1,
      sourceEngine: 'executive-engine',
      salience: 0.7,
      payload: {
        count: output.newGoals.length,
        goals: output.newGoals.map( g => ({
          description: g.description,
          priority: g.priority,
        })),
        confidence: output.confidence,
        tick: footprint.tickObserved
      }
    })

  // self.reflection — when executive includes introspection
  if( output.introspection )
    bus.publish({
      type: 'executive.self.reflection',
      version: 1,
      sourceEngine: 'executive-engine',
      salience: 0.7,
      payload: {
        confidence: output.confidence,
        identifiedBiases: output.introspection.identifiedBiases ?? [],
        lessonsLearned: output.introspection.lessonsLearned ?? [],
        recommendations: output.introspection.recommendations ?? [],
        tick: footprint.tickObserved
      }
    })

  // prediction.formed — top-down signal for satellite engines
  const predictedDomains = inferPredictedDomains( output )

  bus.publish({
    type: 'executive.prediction.formed',
    version: 1,
    sourceEngine: 'executive-engine',
    salience: Math.max( 0.5, salience.observe('executive.prediction', output.confidence ).salience ),
    payload: {
      confidence: output.confidence,
      predictedDomains,
      predictedActions: output.actions.map( a => a.type ),
      tick: footprint.tickObserved
    }
  })
}

const COMMUNICATE_ACTION_TYPES = new Set([
  'communicate', 'speak', 'initiate_conversation', 'reach-out', 'reach_out', 'talk', 'text', 'message',
])

/** Resolve an executive action target (a display name OR a keid) to a known-entity keid. */
function resolveKnownEntity( target: string, state: ReadonlySimulationState ): string | undefined {
  const t = target.trim().toLowerCase()
  for( const e of state.entities.values() ){
    if( e.type !== 'known-entity' ) continue
    const m    = e.metadata as Record<string, unknown> | undefined
    const keid = typeof m?.['keid'] === 'string' ? m['keid'] as string : undefined
    const name = typeof m?.['name'] === 'string' ? m['name'] as string : undefined
    if( keid && keid.toLowerCase() === t ) return keid
    if( name && name.toLowerCase() === t ) return keid
  }
  return undefined
}

/**
 * Turn the executive's imagined actions into `ideomotor.intent` entities (the
 * ideomotor leg). Two kinds are pre-activated: communicate actions (as reach-out
 * toward the resolved entity) and *currently-afforded host abilities* — an action
 * whose type names an external affordance in the field, optionally carrying the
 * `args` the executive consciously supplied (a mind formulating "search the docs
 * for X" IS the situation providing the argument). The AffordanceSynthesizer
 * surfaces them as competing candidates next tick — executive intention ENTERS
 * the competition, it never bypasses it. Refreshed each executive cycle — stale
 * intents the executive no longer imagines are deleted.
 */
function buildIdeomotorIntents(
  output:    ExecutiveOutputFull,
  state:     ReadonlySimulationState,
  footprint: ReasoningFootprint,
): { set: EntityInput[]; delete: string[] } {
  const set:  EntityInput[] = []
  const seen = new Set<string>()
  const priority = clamp01( output.confidence ?? 0.8 )

  // The host abilities currently afforded (source 'external' in the live field) —
  // the executive can only pre-activate what the situation actually offers.
  const externalBySchema = new Map<string, string>()
  for( const e of state.entities.values() ){
    if( e.type !== 'affordance' ) continue
    const m = e.metadata as Record<string, unknown> | undefined
    if( m?.['source'] !== 'external' ) continue
    const schema = typeof m['schema'] === 'string' ? m['schema'] as string : undefined
    if( schema ) externalBySchema.set( schema.toLowerCase(), schema )
  }

  for( const action of output.actions ){
    const t = action.type.toLowerCase()

    if( COMMUNICATE_ACTION_TYPES.has( t ) ){
      if( !action.target ) continue
      const keid = resolveKnownEntity( action.target, state )
      if( !keid || seen.has( keid ) ) continue
      seen.add( keid )
      set.push({
        id:   `ideomotor-reach-out-${ keid }`,
        type: 'ideomotor.intent',
        metadata: { schema: 'reach-out', targetEntityId: keid, priority, origin: 'executive', tick: footprint.tickObserved },
      })
      continue
    }

    // A host ability the executive imagines enacting, with its conscious args.
    const schema = externalBySchema.get( t )
    if( !schema || seen.has( `ability:${ schema }` ) ) continue
    seen.add( `ability:${ schema }` )
    const keid = action.target ? resolveKnownEntity( action.target, state ) : undefined
    set.push({
      id:   `ideomotor-${ schema }${ keid ? `-${ keid }` : '' }`,
      type: 'ideomotor.intent',
      metadata: {
        schema,
        ...( keid ? { targetEntityId: keid } : {} ),
        ...( action.args && typeof action.args === 'object' ? { parameters: action.args } : {} ),
        priority, origin: 'executive', tick: footprint.tickObserved,
      },
    })
  }

  // Clear stale executive-sourced intents the executive no longer imagines this cycle.
  const currentIds = new Set( set.map( s => s.id ) )
  const del: string[] = []
  for( const [ id, e ] of state.entities )
    if( e.type === 'ideomotor.intent'
        && ( e.metadata as Record<string, unknown> | undefined )?.['origin'] === 'executive'
        && !currentIds.has( id ) )
      del.push( id )

  return { set, delete: del }
}

function clamp01( n: number ): number { return n < 0 ? 0 : n > 1 ? 1 : n }

function inferPredictedDomains( output: ExecutiveOutputFull ): string[] {
  const domains = new Set<string>()
  for( const action of output.actions ){
    const t = action.type.toLowerCase()

    if( t.includes('rest') || t.includes('sleep') || t.includes('energy') ) domains.add('energy')
    if( t.includes('social') || t.includes('talk') || t.includes('text') ) domains.add('social')
    if( t.includes('learn') || t.includes('reflect') || t.includes('memorize') ) domains.add('memory')
    if( t.includes('plan') || t.includes('goal') ) domains.add('executive')
    if( t.includes('meditat') || t.includes('calm') ) domains.add('stress')
  }

  if( output.introspection ) domains.add('metacognition')
  if( output.newGoals && output.newGoals.length > 0 ) domains.add('executive')

  return [ ...domains ]
}
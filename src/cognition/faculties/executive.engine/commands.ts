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
import { INNATE_SCHEMA_BY_ID } from '#agency/schemas/innate'
import { logger } from '#core/logger'

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
      if( !u.keid || u.keid === 'agent-self') return

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

/**
 * Action names that mean "say something to someone". Exported because the
 * conversation facet partitions its OWN actions by the same rule (an action
 * aimed at a third party is an intention the master owns, not a reply the facet
 * may deliver) — one definition, so the two ends cannot drift apart.
 */
export const COMMUNICATE_ACTION_TYPES = new Set([
  'communicate', 'speak', 'initiate_conversation', 'reach-out', 'reach_out', 'talk', 'text', 'message',
])

/** Arg keys a mind uses for the words themselves — folded into `gist` (see below). */
const WORDS_ARG_KEYS   = new Set([ 'content', 'message', 'text', 'body' ])
/** Arg keys naming the addressee — already resolved into `targetEntityId`. */
const ADDRESS_ARG_KEYS = new Set([ 'to', 'recipient', 'target', 'targetEntityId', 'entityId' ])

/** Resolve an executive action target (a display name OR a keid) to a known-entity keid. */
function resolveKnownEntity( target: string, state: ReadonlySimulationState ): string | undefined {
  const t = target.trim().toLowerCase()
  for( const e of state.entities.values() ){
    if( e.type !== 'known-entity') continue
    const m    = e.metadata as Record<string, unknown> | undefined
    const keid = typeof m?.['keid'] === 'string' ? m['keid'] as string : undefined
    const name = typeof m?.['name'] === 'string' ? m['name'] as string : undefined
    if( keid && keid.toLowerCase() === t ) return keid
    if( name && name.toLowerCase() === t ) return keid
  }
  return undefined
}

/**
 * The name the mind has LEARNED for this entity. The outreach facet addresses someone
 * by it ("I have decided to reach out to ${ name }"), so a keid leaking through here
 * would have the mind reaching out to `discord:1019376031150379101`. Undefined when
 * unlearned — the caller omits it rather than substituting a placeholder.
 */
function knownEntityName( keid: string, state: ReadonlySimulationState ): string | undefined {
  for( const e of state.entities.values() ){
    if( e.type !== 'known-entity') continue
    const m = e.metadata as Record<string, unknown> | undefined
    if( m?.['keid'] !== keid ) continue
    const name = typeof m['name'] === 'string' ? m['name'].trim() : ''
    return name.length > 0 ? name : undefined
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
  /** Action names that named nothing this cycle — surfaced back to the mind below. */
  const unresolved = new Set<string>()
  /** Addressees the mind meant to reach but cannot resolve to anyone it knows. */
  const unaddressed = new Set<string>()
  const priority = clamp01( output.confidence ?? 0.8 )

  // The host abilities currently afforded (source 'external' in the live field) —
  // the executive can only pre-activate what the situation actually offers.
  const externalBySchema = new Map<string, string>()
  for( const e of state.entities.values() ){
    if( e.type !== 'affordance') continue
    const m = e.metadata as Record<string, unknown> | undefined
    if( m?.['source'] !== 'external') continue
    const schema = typeof m['schema'] === 'string' ? m['schema'] as string : undefined
    if( schema ) externalBySchema.set( schema.toLowerCase(), schema )
  }

  for( const action of output.actions ){
    const t = action.type.toLowerCase()

    if( COMMUNICATE_ACTION_TYPES.has( t ) ){
      // The addressee may be named on the action OR inside the args the executive
      // authored. This used to read `action.target` alone and `continue` when it
      // was absent — but the output guidelines document actions as
      // `{type, reasoning, expectedOutcome}` and tell the mind to put specifics
      // in `args`, so `args.to` is precisely what a well-behaved mind produces.
      // A Will would write real sentences into `args.to`/`args.content`, the
      // intent was never created, nothing competed, nothing was ever enqueued —
      // and reafference then taught it that talking to that PERSON does not work.
      const args = ( action.args && typeof action.args === 'object' ? action.args : {} ) as Record<string, unknown>
      const named = [ action.target, args['to'], args['recipient'], args['target'], args['targetEntityId'], args['entityId'] ]
        .find( v => typeof v === 'string' && v.trim().length > 0 ) as string | undefined
      // Naming NOBODY and naming someone unreachable are different failures, and
      // both used to `continue` in silence — the intent was never created, nothing
      // competed, and the mind had no way to find out. Observed: a facet decided to
      // contact a colleague by a name the mind had heard in conversation but never
      // bound to a dossier; the whole intention evaporated without a trace, and the
      // person it had just promised never heard from it.
      if( !named ){ unaddressed.add('(no one)'); continue }
      const keid = resolveKnownEntity( named, state )
      if( !keid ){ unaddressed.add( named ); continue }
      if( seen.has( keid ) ) continue
      seen.add( keid )
      // The master forms the INTENT; it does not author the words. Whatever it wrote
      // is the DIRECTION for the outreach facet (AuditionEngine.authorOutreach) to
      // speak in — so it lands in `gist`, never `content`. This is load-bearing:
      // MotorSchemaExecutor._deliver sends `parameters.content` VERBATIM and only
      // falls back to the facet when it is empty, so carrying the master's sentences
      // as `content` would put the master itself in a second, parallel conversation
      // with someone a conversation facet may already be talking to — one mind
      // holding two threads with one person about one thing. `gist` was read in
      // three places and written nowhere; this is what writes it.
      const said = [ ...WORDS_ARG_KEYS ]
        .map( k => args[ k ] )
        .find( v => typeof v === 'string' && v.trim().length > 0 ) as string | undefined
      const parameters: Record<string, unknown> = {}
      for( const [ k, v ] of Object.entries( args ) )
        if( !WORDS_ARG_KEYS.has( k ) && !ADDRESS_ARG_KEYS.has( k ) ) parameters[ k ] = v
      if( said ) parameters['gist'] = said
      const targetName = knownEntityName( keid, state )
      if( targetName ) parameters['targetEntityName'] = targetName

      // Named at INFO because this is the seam where a decision to contact someone
      // either becomes a competing intention or disappears. When a Will named a
      // colleague seven times over ten minutes and he never heard from it, nothing
      // in the logs could distinguish "the intent was never created" from "it was
      // created and lost every competition" — the two have completely different
      // fixes, and the archaeology to tell them apart needed state snapshots that
      // sample too coarsely to catch a cycle.
      logger.info(
        `[executive] willed reach-out → ${ targetName ?? keid } ` +
        `(named '${ named }' → ${ keid }, priority=${ priority.toFixed( 2 ) })`
      )

      set.push({
        id:   `ideomotor-reach-out-${ keid }`,
        type: 'ideomotor.intent',
        metadata: {
          schema: 'reach-out', targetEntityId: keid,
          ...( Object.keys( parameters ).length > 0 ? { parameters } : {} ),
          priority, origin: 'executive', tick: footprint.tickObserved,
        },
      })
      continue
    }

    // A host ability the executive imagines enacting, with its conscious args.
    const schema = externalBySchema.get( t )
    if( !schema ){
      // The name resolves to NOTHING: not a communicate type, not an innate
      // stance, not an ability the field affords. Record it so the mind can find
      // out. Silence here is what let a Will spend eleven consecutive actions on
      // an invented `query`, observe that nothing ever came of them, and conclude
      // its MEMORY was broken — the one explanation that was not true.
      if( !INNATE_SCHEMA_BY_ID.has( t ) ) unresolved.add( action.type )
      continue
    }
    if( seen.has(`ability:${ schema }`) ) continue
    seen.add(`ability:${ schema }`)
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

  // An action that named nothing is REPORTED, not swallowed.
  //
  // The executive's actions bias the agency competition; they are not commands, so
  // a name that matches no schema is not a dispatch error and nothing downstream
  // ever objected. But an unopposed no-op is indistinguishable from an act that
  // was tried and achieved nothing, and the mind reasons from the difference.
  // Observed: eleven consecutive `query` actions (a name that does not exist),
  // then "five consecutive queries with no memory trace is a failure mode" and a
  // plan to diagnose its own memory. Telling it the name was not real costs one
  // entity and removes a whole class of false self-belief.
  if( unresolved.size > 0 )
    set.push({
      id:   'action.unresolved',
      type: 'action.unresolved',
      metadata: {
        names:   [ ...unresolved ],
        summary: `I named ${ [ ...unresolved ].map( n => `'${ n }'` ).join(', ') } as an action, but ${ unresolved.size > 1 ? 'those are not things' : 'that is not a thing' } I can do — no such ability is in my repertoire or afforded right now. Nothing happened. To act I have to name something I actually have.`,
        salience: 0.75,
        origin:   'executive',
        tick:     footprint.tickObserved,
      },
    })

  // An addressee that resolves to nobody is REPORTED, not swallowed.
  //
  // Same principle as the unresolved-name report above, one layer down: there the
  // *verb* named nothing, here the *person* does. The mind can hear a name in
  // conversation ("coordinate that through FKEM") long before that name is bound
  // to anyone it can actually reach, and reaching-out to an unbound name simply
  // does not happen. Told, it can do the human thing — ask how to reach them, or
  // ask whoever mentioned them to make the introduction. Untold, it believes it
  // made contact and follows up on a message it never sent.
  if( unaddressed.size > 0 )
    set.push({
      id:   'action.unaddressed',
      type: 'action.unaddressed',
      metadata: {
        names:   [ ...unaddressed ],
        summary: `I meant to reach ${ [ ...unaddressed ].map( n => `'${ n }'` ).join(', ') }, but ${ unaddressed.size > 1 ? 'those names match no one' : 'that name matches no one' } I know how to contact — no message went out. If I want to reach them I need a way to: someone can introduce us, or tell me where to find them.`,
        salience: 0.8,
        origin:   'executive',
        tick:     footprint.tickObserved,
      },
    })

  // Clear stale executive-sourced intents the executive no longer imagines this cycle.
  const currentIds = new Set( set.map( s => s.id ) )
  const del: string[] = []
  for( const [ id, e ] of state.entities )
    if( e.type === 'ideomotor.intent'
        && ( e.metadata as Record<string, unknown> | undefined )?.['origin'] === 'executive'
        && !currentIds.has( id ) )
      del.push( id )

  // Clear the report once the mind names only real actions again — it should read
  // as "that last attempt was not a thing", not as a permanent defect in itself.
  if( unresolved.size === 0 && state.entities.has('action.unresolved') )
    del.push('action.unresolved')
  if( unaddressed.size === 0 && state.entities.has('action.unaddressed') )
    del.push('action.unaddressed')

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
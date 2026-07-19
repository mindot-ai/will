// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/context.ts
// ─────────────────────────────────────────────────────────────

import type { ReadonlySimulationState } from '#core/types'
import type { GoalManager } from '#faculties/goal.manager'
import type { WorkingMemory } from '#faculties/working.memory'
import type { ExecutiveContext } from '#faculties/executive.engine/types'
import type { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import type { SemanticIntegrator } from '#faculties/semantic.engine/integrator'
import { readEffectiveParams, summarizePersonaPrior } from '#cognition/persona.prior'

export interface ContextDependencies {
  workingMemory: WorkingMemory | null
  goalManager: GoalManager | null
  episodicConsolidator: EpisodicConsolidator | null
  semanticIntegrator: SemanticIntegrator | null
}

export async function buildExecutiveContext(
  state: ReadonlySimulationState,
  deps: ContextDependencies,
  /**
   * Optional override for the episodic-recall query. When a focus supplies it
   * (e.g. a conversation facet passes the current message), it drives the single
   * "## Relevant Memories" section instead of the general state+goals query —
   * so conversation recall is message-relevant AND there is exactly one recall
   * surface (no separate per-focus recall block).
   */
  recallQuery?: string,
): Promise<ExecutiveContext> {
  // Identity — read directly from the identity-self entity.
  const identityEntity  = state.entities.get('identity-self')
  // name is the canonical persona name from WillConfig.name (e.g. "Aria", "Guard-1").
  // Falls back to 'Will' for snapshots created before this field was added.
  const identityName   = (identityEntity?.metadata?.name   as string)                    ?? 'Will'
  const identityPrompt = (identityEntity?.metadata?.prompt as string)                    ?? 'I am a self-aware mind.'
  const identityValues = (identityEntity?.metadata?.values as string[])                  ?? []
  const identityTraits = (identityEntity?.metadata?.traits as Record<string, number>)    ?? {}
  // Per-trait baseline + recency (graded salience B/C) — present once the self-model has evaluated.
  const identityTraitStats = identityEntity?.metadata?.traitStats as
    Record<string, { mean: number; shiftDir: number; shiftTick: number }> | undefined
  const identityStyle  = (identityEntity?.metadata?.style  as string)                    ?? 'natural and authentic'

  // Working memory — getItems() returns WMItem[] sorted by activation descending.
  // Filter types that are already rendered elsewhere in the prompt:
  //   conversation.exchange → shown in Recent Action Outcomes
  //   goal                  → shown in Active Goals
  const WM_FILTER_TYPES = new Set([ 'conversation.exchange', 'goal' ])
  const wmItems = ( deps.workingMemory?.getItems() ?? [] )
    .filter( item => !WM_FILTER_TYPES.has( item.type ) )
  const workingMemory = wmItems.map( item => ({
    type: item.type,
    summary: extractSummary( item.content ),
    activation: item.activation
  }))

  // Episodic memory — semantic query for relevant memories based on current goals
  // and affective state. Falls back to recent query if semantic not available.
  let memories: ExecutiveContext['memories'] = []
  // Plan ids surfaced by THIS recall (descriptors carry planId) — feeds the
  // relevance filter on the Active Plans awareness section (recall-scoped awareness).
  let relevantPlanIds: string[] = []

  if( deps.episodicConsolidator ){
    // Focus-supplied query (e.g. the live conversation message) takes precedence;
    // otherwise build a general query from current state + goals.
    const semanticQuery = recallQuery && recallQuery.trim().length > 0
      ? recallQuery
      : buildSemanticQuery( state, deps.goalManager )
    
    try {
      // Try semantic search first (if vector memory configured).
      // Omit minSimilarity → defers to the adapter's configured default (0.35,
      // tuned for real sentence embeddings). Hardcoding 0.65 here starved recall.
      // affectiveBias adds gentle mood-congruent recall: memories encoded in a
      // mood like the current one surface a little more readily (weight 0.15 so
      // similarity still dominates).
      const moodValence = state.metrics.get('affect.valence') ?? 0
      const semanticResults = await deps.episodicConsolidator.semanticQuery(
        semanticQuery,
        { limit: 10, affectiveBias: { valence: moodValence, weight: 0.15 } }
      )
      
      // Augment with recent memories for freshness
      const recentResults = deps.episodicConsolidator.query({ limit: 5 })
      
      // Deduplicate by id and combine
      const seen = new Set<string>()
      const combined: typeof semanticResults = []
      
      for( const ep of semanticResults ){
        if( !seen.has( ep.id ) ){
          seen.add( ep.id )
          combined.push( ep )
        }
      }
      for( const ep of recentResults ){
        if( !seen.has( ep.id ) ){
          seen.add( ep.id )
          combined.push( ep )
        }
      }
      
      // Filter goal-type episodes — they duplicate the Active Goals section
      const recalled = combined.filter( ep => ep.sourceType !== 'goal').slice( 0, 8 )
      relevantPlanIds = collectPlanIds( recalled )
      memories = recalled.map( mapEpisodeToMemory )
      // Recall reinforces retention: marking each surfaced episode as retrieved
      // increments its retrievalCount, which unlocks the ForgettingCurve's
      // retrievalBoost so actively-recalled memories decay slower than unused ones.
      for( const ep of recalled ) deps.episodicConsolidator?.markRetrieved( ep.id, state.tick )
    }
    catch( err ){
      // Fallback to recent query if semantic fails (no vector memory configured).
      // Sort by createdAt descending so the most recent memories surface first —
      // the default query order may not be chronological when using PMA replay.
      const fallbackResults = deps.episodicConsolidator.query({ limit: 20 })
      const recalled = fallbackResults
        .filter( ep => ep.sourceType !== 'goal')
        .slice()
        .sort( ( a, b ) => ( ( b.createdAt as unknown as number ) ?? 0 ) - ( ( a.createdAt as unknown as number ) ?? 0 ) )
        .slice( 0, 8 )
      relevantPlanIds = collectPlanIds( recalled )
      memories = recalled.map( mapEpisodeToMemory )
      for( const ep of recalled ) deps.episodicConsolidator?.markRetrieved( ep.id, state.tick )
    }
  }

  // Goals — built before beliefs so their tags can inform belief relevance scoring.
  const goalsList = deps.goalManager?.getActiveGoals() ?? []
  const activeGoalTags = new Set( goalsList.flatMap( g => g.tags ) )
  const goals = goalsList.map( g => ({
    id: g.id,
    description: g.description,
    priority: g.priority,
    progress: g.progress,
    status: g.status,
    deadline:              g.deadline as number | undefined,
    lastActionAttemptTick: g.lastActionAttemptTick,
    lastActionType:        g.lastActionType,
  }))

  // Beliefs — deduplicated, scored by relevance, and capped to prevent attention dilution.
  //
  // Pipeline:
  //   1. Dedup: within the same category, drop beliefs with >DEDUP_THRESHOLD Jaccard
  //      similarity to an already-accepted belief (keep higher-confidence version).
  //   2. Score: confidence × recency × goal-tag-match.
  //   3. Cap: at most PER_CATEGORY_CAP per category, then global BELIEF_PROMPT_LIMIT.
  //
  // Constants:
  //   BELIEF_PROMPT_LIMIT    — max beliefs in the prompt (was 50, reduced to 30)
  //   PER_CATEGORY_CAP       — no single category dominates attention
  //   DEDUP_THRESHOLD        — Jaccard similarity above which a belief is a duplicate
  //   RECENCY_HALF_LIFE      — ticks after which a belief's recency score halves
  //   GOAL_TAG_BOOST         — multiplier when a belief shares tags with active goals
  //   RECENCY_FLOOR          — minimum recency so old high-value beliefs aren't buried
  const BELIEF_PROMPT_LIMIT = 30
  const PER_CATEGORY_CAP    = 8
  const DEDUP_THRESHOLD     = 0.70
  const RECENCY_HALF_LIFE   = 200
  const GOAL_TAG_BOOST      = 1.4
  const RECENCY_FLOOR       = 0.4

  const allBeliefs  = deps.semanticIntegrator?.getBeliefs() ?? []
  const currentTick = state.tick as unknown as number

  // ── Stage 1: Deduplication ────────────────────────────────
  const _tokenize = ( s: string ): Set<string> =>
    new Set( s.toLowerCase().replace( /[^a-z0-9 ]/g, '').split( /\s+/ ).filter( Boolean ) )

  const _jaccard = ( a: Set<string>, b: Set<string> ): number => {
    let intersection = 0
    for( const t of a ) if( b.has( t ) ) intersection++
    return intersection / ( a.size + b.size - intersection )
  }

  // Sort highest-confidence first so the winner of each duplicate cluster is kept.
  const sortedForDedup = [ ...allBeliefs ].sort( ( a, b ) => b.confidence - a.confidence )
  const acceptedBeliefs: Array<(typeof allBeliefs)[number]> = []
  const acceptedTokens: Array<{ tokens: Set<string>; category: string }> = []

  for( const belief of sortedForDedup ){
    const tokens = _tokenize( belief.statement )
    const isDuplicate = acceptedTokens.some( ({ tokens: ut, category: uc }) =>
      uc === belief.category && _jaccard( tokens, ut ) > DEDUP_THRESHOLD
    )
    if( !isDuplicate ){
      acceptedBeliefs.push( belief )
      acceptedTokens.push({ tokens, category: belief.category })
    }
  }

  const beliefsOmittedByDedup = allBeliefs.length - acceptedBeliefs.length

  // ── Stage 2: Relevance scoring ────────────────────────────
  const scoredBeliefs = acceptedBeliefs
    .map( b => {
      const ticksSince = Math.max( 0, currentTick - ( b.lastUpdatedAt as unknown as number ) )
      const recency    = Math.max( RECENCY_FLOOR, 1 / ( 1 + ticksSince / RECENCY_HALF_LIFE ) )
      const goalMatch  = b.tags.some( t => activeGoalTags.has( t ) ) ? GOAL_TAG_BOOST : 1.0
      return { b, score: b.confidence * recency * goalMatch }
    } )
    .sort( ( a, b ) => b.score - a.score )

  // ── Stage 3: Per-category cap + global cap ────────────────
  const categoryCount = new Map<string, number>()
  const cappedBeliefs: typeof scoredBeliefs = []
  for( const item of scoredBeliefs ){
    const cat   = item.b.category
    const count = categoryCount.get( cat ) ?? 0
    if( count >= PER_CATEGORY_CAP ) continue
    categoryCount.set( cat, count + 1 )
    cappedBeliefs.push( item )
    if( cappedBeliefs.length >= BELIEF_PROMPT_LIMIT ) break
  }

  const beliefs = cappedBeliefs
    .map( ( { b } ) => ({ statement: b.statement, category: b.category, confidence: b.confidence }))

  const beliefsOmitted = Math.max( 0, allBeliefs.length - beliefs.length )
  void beliefsOmittedByDedup  // surfaced via beliefsOmitted total

  // Percepts — extract from state entities, sort by salience, take top 10.
  const percepts = extractPercepts( state )

  // Affect — read from state entities and computed metrics.
  // dominantEmotion and blends are strings/arrays stored on affect-related entities,
  // not in the numeric metrics map.
  const affect = extractAffect( state )

  // Behavioral disposition — PMA seeds risk/exploration/impulsivity onto
  // engine-config-executive at session start, and the persona-prior mirror then
  // *develops* it (base ⊕ prior): exploration grows with openness/creativity,
  // impulsivity falls as conscientiousness is demonstrated. So it is no longer static
  // per session. `readEffectiveParams` only layers a prior onto a key the base already
  // has, so absent a PMA seed this degrades to base ⇒ undefined disposition.
  const execParams = readEffectiveParams( state, 'engine-config-executive')
  const behavioralDisposition = (
    execParams.riskTolerance   !== undefined ||
    execParams.explorationRate !== undefined ||
    execParams.impulsivity     !== undefined
  ) ? {
    riskTolerance:   execParams.riskTolerance   ?? 0.5,
    explorationRate: execParams.explorationRate ?? 0.3,
    impulsivity:     execParams.impulsivity     ?? 0.3,
  } : undefined

  // Recent action outcomes — scan decision.record entities that have been processed
  // (actionStatus is set) and return the last 5 most recent, newest first.
  // This closes the Act → Confirm → Perceive loop: the executive can see what it
  // tried, whether it landed, and whether an external dispatch went unanswered.
  const recentActions: Array<{
    type: string; status: 'completed' | 'failed' | 'awaiting_host' | 'timed_out'
    tick: number; outcome: string; planId?: string
  }> = []

  for( const entity of state.entities.values() ){
    if( entity.type !== 'decision.record') continue
    const actionStatus = entity.metadata?.actionStatus as string | undefined
    if( !actionStatus ) continue
    if( !( [ 'completed', 'failed', 'awaiting_host', 'timed_out' ] as string[] ).includes( actionStatus ) ) continue

    recentActions.push({
      type:   ( entity.metadata?.actionType as string )    ?? 'unknown',
      status: actionStatus as 'completed' | 'failed' | 'awaiting_host' | 'timed_out',
      tick:   ( entity.metadata?.executionTick as number ) ?? ( entity.metadata?.dispatchedAt as number ) ?? 0,
      outcome: String( entity.metadata?.outcome ?? '').slice( 0, 120 ),
      planId: entity.metadata?.planId as string | undefined,
    })
  }

  // Sort newest-first, cap at 5
  recentActions.sort( ( a, b ) => b.tick - a.tick )
  const recentActionsCapped = recentActions.slice( 0, 5 )

  // Active/known plans — read persisted `plan` entities so the executive has
  // execution awareness: which plans exist per goal, their status + step
  // progress, enabling it to target a specific plan by id when managing several. (P4)
  const plans: ExecutiveContext['plans'] = []
  for( const entity of state.entities.values() ){
    if( entity.type !== 'plan') continue
    const m = entity.metadata ?? {}
    const steps = ( m['steps'] as Array<{ status?: string }> | undefined ) ?? []
    plans.push({
      id:              entity.id,
      goalId:          ( m['goalId'] as string ) ?? '',
      status:          ( m['status'] as string ) ?? 'unknown',
      executionTier:   ( m['executionTier'] as string ) ?? 'automatic',
      totalSteps:      steps.length,
      completedSteps:  steps.filter( s => s.status === 'completed' || s.status === 'skipped').length,
      expectedOutcome: ( m['expectedOutcome'] as string ) ?? '',
      requestingEntityId: m['requestingEntityId'] as string | undefined,
    })
  }

  // How the Will has self-tuned its own faculties (metacognition persona-prior).
  const selfTuningList = summarizePersonaPrior( state ).map( a => a.description )
  const selfTuning = selfTuningList.length > 0 ? selfTuningList : undefined

  return {
    identity: {
      name:   identityName,
      prompt: identityPrompt,
      values: identityValues,
      traits: identityTraits,
      traitStats: identityTraitStats,
      style:  identityStyle
    },
    worldState: {
      energyLevel: state.metrics.get('energy.level') ?? 100,
      sleepPressure: state.metrics.get('sleep.pressure') ?? 0,
      stressLoad: state.metrics.get('stress.load') ?? 0,
      circadianPhase: state.metrics.get('circadian.phase') ?? 0,
      timeOfDay: state.metrics.get('time.of_day') ?? 12,
      // Tonic threat representation — survives event habituation (guardrail).
      threatLevel: state.metrics.get('threat.level') ?? 0
    },
    affect,
    goals,
    plans,
    relevantPlanIds,
    percepts,
    abilities: extractAbilities( state ),
    workingMemory,
    memories,
    beliefs,
    beliefsOmitted,
    recentActions: recentActionsCapped,
    behavioralDisposition,
    selfTuning,
    knownEntities: extractKnownEntities( state ),
    currentFocus: extractCurrentFocus( state, goals )
  }
}

/**
 * Host-declared abilities afforded to the Will right now — read from the current
 * `affordance` field (source 'external', available). Gives System 2 knowledge of
 * what it can do + what each is for; the innate stances are already in the
 * preamble, so only host effectors surface here. Capped so a wide catalog can't
 * bloat the prompt.
 */
const MAX_SURFACED_ABILITIES = 8
export function extractAbilities( state: ReadonlySimulationState ): ExecutiveContext['abilities'] {
  const out: NonNullable<ExecutiveContext['abilities']> = []
  for( const e of state.entities.values() ){
    if( e.type !== 'affordance') continue
    const m = e.metadata as Record<string, unknown> | undefined
    if( m?.['source'] !== 'external' || m?.['available'] === false ) continue
    const name = typeof m?.['schema'] === 'string' ? m['schema'] as string : undefined
    if( !name ) continue
    const description = typeof m['description'] === 'string' ? m['description'] as string : undefined
    const params = m['parameters'] as Record<string, unknown> | undefined
    const target = m['targetEntityId']
      ? ( typeof params?.['targetEntityName'] === 'string' ? params['targetEntityName'] as string : String( m['targetEntityId'] ) )
      : undefined
    out.push( { name, ...( description ? { description } : {} ), ...( target ? { target } : {} ) } )
    if( out.length >= MAX_SURFACED_ABILITIES ) break
  }
  return out.length > 0 ? out : undefined
}

/**
 * What the Will is currently focused on (the `task-switch-focus` entity from task.switcher)
 * plus the effort cost of switching away (the `task_switch.switch_cost` metric = effective
 * baseSwitchCost). Surfaces task-persistence into the executive's reasoning — previously
 * task.switcher computed this but it reached nothing. Undefined when nothing is in focus.
 */
export function extractCurrentFocus(
  state: ReadonlySimulationState,
  goals: ExecutiveContext['goals']
): ExecutiveContext['currentFocus'] {
  const m = state.entities.get('task-switch-focus')?.metadata as Record<string, unknown> | undefined
  if( !m?.goalId ) return undefined
  return {
    goalId:          m.goalId as string,
    goalDescription: goals.find( g => g.id === m.goalId )?.description,
    focusTicks:      ( m.focusTicks as number ) ?? 0,
    switchCost:      state.metrics.get('task_switch.switch_cost') ?? 0,
  }
}

/**
 * The Will's social models — its understanding of other agents. Joins the social-cognition
 * stack by keid: theory-of-mind (`tom-*`: what they want/feel), reputation
 * (`reputation-*`: trust/cooperativeness), and attachment (`bond-*`: closeness). Sorted by
 * interaction recency and capped, so the executive can reason about *whom it is dealing
 * with* without flooding the prompt. Undefined when the Will knows no one.
 */
export function extractKnownEntities( state: ReadonlySimulationState ): ExecutiveContext['knownEntities'] {
  type Acc = NonNullable<ExecutiveContext['knownEntities']>[number] & { _recency: number }
  const byKeid = new Map<string, Acc>()

  // Recognition (Phase 5): redirect a fused alias keid to its canonical referent, so the
  // triple / dossier / beliefs under the old keid all aggregate under the one someone.
  const alias = new Map<string, string>()
  for( const e of state.entities.values() )
    if( e.type === 'known-entity-alias'){
      const a = e.metadata?.aliasKeid as string | undefined
      const c = e.metadata?.canonicalKeid as string | undefined
      if( a && c ) alias.set( a, c )
    }
  const get = ( id: string ): Acc => {
    id = alias.get( id ) ?? id
    let a = byKeid.get( id )
    // kind is 'sentient' for the whole social triple; 'thing' dossiers arrive with the
    // generalised store. name stays undefined until the Will actually learns it.
    if( !a ){ a = { keid: id, kind: 'sentient', _recency: 0 }; byKeid.set( id, a ) }
    return a
  }

  for( const e of state.entities.values() ){
    const m = ( e.metadata ?? {} ) as Record<string, unknown>
    if( e.type === 'theory_of_mind' && m.keid ){
      const a = get( m.keid as string )
      a.intention  = ( m.dominantIntention as string | null ) ?? undefined
      a.emotion    = ( m.estimatedEmotion as string | null ) ?? undefined
      a.confidence = m.modelConfidence as number
    }
    else if( e.type === 'reputation' && m.keid ){
      const a = get( m.keid as string )
      if( typeof m.name === 'string') a.name = m.name
      a.trust           = m.trustworthiness as number
      a.cooperativeness = m.cooperativeness as number
      a.reliability   ??= m.reliability as number   // sentient social reliability — the dossier's wins if present
      a._recency        = Math.max( a._recency, ( m.lastInteractionTick as number ) ?? 0 )
    }
    else if( e.type === 'known-entity' && m.keid ){
      // The perceptual dossier (known.entity.tracker): a learned name, the kind, recency,
      // and the *general* track-record reliability (decision #3 — authoritative over the
      // sentient social one). (familiarity is intentionally NOT surfaced — it decays each
      // tick and would churn the cached prompt; it stays internal to the tracker.)
      const a = get( m.keid as string )
      if( typeof m.name === 'string') a.name = m.name
      if( m.kind === 'thing' || m.kind === 'sentient') a.kind = m.kind as 'thing' | 'sentient'
      if( typeof m.reliability === 'number') a.reliability = m.reliability as number
      a._recency = Math.max( a._recency, ( m.lastSeenTick as number ) ?? 0 )
    }
    else if( e.type === 'attachment.bond'){
      const keid = ( m.keid as string ) ?? e.id.replace( /^bond-/, '')
      get( keid ).closeness = m.attachmentStrength as number
    }
  }

  const entities = [ ...byKeid.values() ]
    .sort( ( a, b ) => b._recency - a._recency || ( b.closeness ?? 0 ) - ( a.closeness ?? 0 ) )
    .slice( 0, 6 )
    .map( ( { _recency, ...rest } ) => rest )

  return entities.length > 0 ? entities : undefined
}

/**
 * Build a semantic query string from current cognitive state.
 * Combines active goals, current affect, and recent percepts.
 */
function buildSemanticQuery(
  state: ReadonlySimulationState,
  goalManager: GoalManager | null
): string {
  const parts: string[] = []

  // Active goals (highest priority first)
  const goals = goalManager?.getActiveGoals().slice( 0, 3 ) ?? []
  if( goals.length > 0 ){
    parts.push(`Current goals: ${goals.map( g => g.description ).join('; ')}`)
  }

  // Dominant emotion if intense
  const valence = state.metrics.get('affect.valence') ?? 0
  const dominantEmotion = valence > 0.3 ? 'positive' : valence < -0.3 ? 'negative' : 'neutral'
  if( dominantEmotion !== 'neutral') parts.push(`Feeling ${dominantEmotion}`)

  // Active conversation entities — pulls memories about current interlocutors
  const senderNames = new Set<string>()
  for( const entity of state.entities.values() ){
    if( entity.type !== 'communication') continue
    const msgTick = ( entity.metadata?.tick as number ) ?? 0
    if( state.tick - msgTick > 30 ) continue
    if( entity.metadata?.processedByExecutive ) continue
    const name = entity.metadata?.agentName as string | undefined
    if( name && name !== 'unknown') senderNames.add( name )
  }
  if( senderNames.size > 0 ) parts.push(`Talking with: ${[ ...senderNames ].join(', ')}`)

  // Recent percepts (top 3 by salience)
  const percepts = extractPercepts( state ).slice( 0, 3 )
  if( percepts.length > 0 ){
    parts.push(`Recently observed: ${percepts.map( p => p.summary ).join('; ')}`)
  }

  return parts.length > 0 ? parts.join('. ') : 'Current situation'
}

/** Pull planIds from recalled plan-descriptor episodes (their content carries planId). */
function collectPlanIds( episodes: Array<{ content: unknown }> ): string[] {
  const ids: string[] = []
  for( const ep of episodes ){
    const c = ep.content as Record<string, any> | null | undefined
    const pid = c?.[ 'planId' ] ?? c?.[ 'content' ]?.[ 'planId' ]
    if( typeof pid === 'string') ids.push( pid )
  }
  return [ ...new Set( ids ) ]
}

function _extractEpisodeContent( raw: unknown ): string {
  if( typeof raw === 'string') return raw
  if( typeof raw !== 'object' || raw === null ) return String( raw )
  const c = raw as Record<string, unknown>

  // WMItem wrapper: { wmType, content: { description | summary | ... } }
  // Check wmType first so we correctly unwrap structured WM items.
  if( typeof c['wmType'] === 'string'){
    const inner = c['content']
    if( typeof inner === 'string') return inner
    if( typeof inner === 'object' && inner !== null ){
      const ic = inner as Record<string, unknown>
      if( typeof ic['description'] === 'string') return ic['description']
      if( typeof ic['summary']     === 'string') return ic['summary']
      if( typeof ic['userMessage'] === 'string'){
        const reply = typeof ic['willReply'] === 'string' ? ` → "${ic['willReply']}"` : ''
        return `"${ic['userMessage']}"${reply}`
      }
    }
  }

  // Plain percept WMItem: { summary }  or nested { content: { summary } }
  if( typeof c['summary'] === 'string') return c['summary']
  const inner = c['content']
  if( typeof inner === 'string') return inner
  if( typeof inner === 'object' && inner !== null ){
    const ic = inner as Record<string, unknown>
    if( typeof ic['summary'] === 'string') return ic['summary']
    if( typeof ic['description'] === 'string') return ic['description']
  }
  // Belief: { statement }
  if( typeof c['statement'] === 'string') return c['statement']
  // Conversation turn: { userMessage, willReply }
  if( typeof c['userMessage'] === 'string'){
    const reply = typeof c['willReply'] === 'string' ? ` → "${c['willReply']}"` : ''
    return `"${c['userMessage']}"${reply}`
  }
  // Goal: { description }
  if( typeof c['description'] === 'string') return c['description']
  return JSON.stringify( raw ).slice( 0, 200 )
}

function mapEpisodeToMemory( ep: {
  content: unknown
  emotionalTags?: Record<string, number>
  activationStrength: number
  timestamp?: unknown
} ): {
  content: string
  relevance: number
  emotionalContext: string
  tick?: number
} {
  const dominantEmotion = Object.entries( ep.emotionalTags ?? {} )
                                .sort( ( [, a], [, b] ) => b - a )[0]?.[0] ?? 'neutral'

  return {
    content:          _extractEpisodeContent( ep.content ),
    relevance:        ep.activationStrength,
    emotionalContext: dominantEmotion,
    tick:             typeof ep.timestamp === 'number' ? ep.timestamp : undefined
  }
}

function extractSummary( content: unknown ): string {
  if( typeof content === 'string')
    return content.slice( 0, 120 )

  if( content && typeof content === 'object'){
    const obj = content as Record<string, unknown>

    return (obj.summary as string)
            ?? (obj.description as string)
            ?? JSON.stringify( content ).slice( 0, 120 )
  }

  return String( content ?? '').slice( 0, 120 )
}

function extractPercepts( state: ReadonlySimulationState ): Array<{ category: string; summary: string; salience: number }> {
  const percepts: Array<{ category: string; summary: string; salience: number }> = []

  for( const entity of state.entities.values() ){
    if( entity.type !== 'percept' && entity.type !== 'percept.social') continue

    const summary = (entity.metadata?.summary as string)
                    ?? (entity.metadata?.content as string)
                    ?? ''
    if( !summary || summary.startsWith('New percept:') ) continue

    percepts.push({
      category: (entity.metadata?.category as string) ?? 'general',
      summary,
      salience: (entity.metadata?.salience as number) ?? 0
    })
  }

  return percepts.sort( ( a, b ) => b.salience - a.salience ).slice( 0, 10 )
}

/**
 * Extract affective state from the simulation.
 *
 * Valence, arousal, and dominance are numeric metrics stored in state.metrics
 * (Map<string, number>). dominantEmotion and blends are non-numeric — they come
 * from the affective state entity written by AffectiveBlender each tick.
 */
function extractAffect( state: ReadonlySimulationState ): ExecutiveContext['affect'] {
  // Numeric core affect dimensions — these ARE in the metrics map.
  const valence   = state.metrics.get('affect.valence')   ?? 0
  const arousal   = state.metrics.get('affect.arousal')   ?? 0.5
  const dominance = state.metrics.get('affect.dominance') ?? 0.5

  // Non-numeric affect data — read from the affective-state entity.
  // AffectiveBlender writes this entity each tick with dominantEmotion and blends.
  let dominantEmotion = 'neutral'
  let blends: string[] = []

  const affectEntity = state.entities.get('affective-state')
  if( affectEntity ){
    dominantEmotion = (affectEntity.metadata?.dominantEmotion as string) ?? 'neutral'
    blends = (affectEntity.metadata?.blends as string[]) ?? []
  }

  return { dominantEmotion, valence, arousal, dominance, blends }
}
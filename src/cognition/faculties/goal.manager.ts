// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/goal.manager.ts
// ─────────────────────────────────────────────────────────────

/**
 * GoalManager — maintains the active goal hierarchy.
 *
 * Manages:
 *   - Goal activation and deactivation based on drives and context
 *   - Goal priority ordering (conflict resolution)
 *   - Progress tracking
 *   - Goal completion and abandonment
 *   - Sub-goal decomposition
 *
 * Goals are entities in the state manager. The GoalManager reads
 * drive signals from regulatory engines and perceptual context to
 * determine which goals should be active, then updates their
 * priorities and tracks progress.
 *
 * Part of Shard 3 (Executive Layer) — runs every tick, synchronous.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { SessionLogger } from '#stem/tracts/session.logger'
import { readEffectiveParams } from '#cognition/persona.prior'
import { GenerativeModel } from '#cognition/generative.model'

export interface GoalManagerConfig {
  /** Maximum active goals at once */
  maxActiveGoals?: number
  /** How quickly goal priority decays without reinforcement */
  priorityDecayRate?: number
  /** Minimum priority before a goal is deactivated */
  deactivationThreshold?: number
  /**
   * Resilience / grit. A goal whose priority ≥ gritPriority is NEVER auto-abandoned
   * by staleness — the mind only lets it go by a deliberate executive decision.
   * Below that, the staleness patience window scales with priority by
   * gritPatienceScale (important stuck goals are pursued much longer).
   */
  gritPriority?: number
  gritPatienceScale?: number
  /** Frustration tolerance [0–1]: how much the frustration emotion is allowed to
   *  compress the patience window. High tolerance → setbacks don't make the mind
   *  give up faster. A personality dimension (seeded by PMA, developed by metacog). */
  frustrationTolerance?: number
  /**
   * How many new beliefs must form after a goal activates for it to be
   * considered complete. Applies only to epistemic (non-drive) goals.
   */
  epistemicBeliefThreshold?: number
  bus?: CognitiveBus
}

/** Drive-related tags — used to recognise goals spawned by drive signals. */
const DRIVE_TAGS = new Set([ 'energy', 'sleep', 'stress', 'survival', 'wellbeing', 'external', 'demand' ])

// Task-persistence commitment (Channel A). The goal task.switcher is focused on gets a
// bounded priority boost that BUILDS the longer it's been focused, is AMPLIFIED by sunk
// cost in an in-progress plan (planning.engine), and SCALES with the switch cost (= the
// conscientiousness-developable baseSwitchCost, #28). Recomputed fresh each tick from
// basePriority — never accumulates. This is what makes the focus mechanically "stick":
// the focused goal stays top for goal selection, the executive, and planning.
const FOCUS_COMMITMENT_RAMP = 30   // ticks of focus to reach full commitment weight
const COMMITMENT_GAIN       = 0.3  // scales switchCost × commitment × plan-sunk-cost
const MAX_COMMITMENT_BOOST  = 0.2  // cap — a clearly higher-priority goal still wins


export interface GoalState {
  id: string
  description: string
  priority: number         // 0-1: current priority
  basePriority: number     // 0-1: priority from drives (stable)
  progress: number         // 0-1
  status: 'active' | 'blocked' | 'completed' | 'abandoned' | 'pending' | 'pending_verification'
  parentGoalId?: string
  subGoals: string[]
  activatedAt: Tick
  deadline?: Tick
  tags: string[]
  /** Snapshot of memory.beliefs_total when this goal was activated.
   *  Used to compute epistemic progress: (currentBeliefs - baseline) / threshold. */
  beliefsAtActivation: number

  /**
   * How this goal knows it is done — set at creation time, not inferred from tags.
   *
   * 'metric'    — a measurable state crosses a threshold (completionCondition).
   * 'action'    — a real-world outcome must occur; stays 0% if impossible and
   *               is abandoned through frustration rather than belief formation.
   * 'epistemic' — resolved through understanding: belief formation about the
   *               situation, the self, or the world.
   */
  completionType: 'metric' | 'action' | 'epistemic' | 'pending_verification'

  /** For 'metric' goals: e.g. "stress.load < 40" or "energy.level > 80".
   *  Parsed and evaluated each tick to compute smooth progress. */
  completionCondition?: string

  /** Tick of the most recent action.outcome that matched this goal's tags.
   *  Lets the executive see "I tried this N ticks ago" without scanning decision.records. */
  lastActionAttemptTick?: number
  /** ActionType of the most recent attempt (e.g. 'text', 'talk', 'observe'). */
  lastActionType?: string

  /**
   * Causal link back to the entity whose message triggered this goal.
   * Populated when a conversation escalation creates the goal (AuditionEngine → executive).
   * Used by PlanningEngine to tag plan bus events so the activity SSE stream can
   * filter and forward them to the correct requesting entity.
   */
  requestingEntityId?: string
  /** Thread ID of the conversation turn that triggered this goal (for reply correlation). */
  requestingThreadId?: string
}

export class GoalManager implements SimulationEngine, CognitiveEngine {
  readonly name = 'goal-manager'
  
  private _maxActiveGoals: number
  private _priorityDecayRate: number
  private _basePriorityDecayRate: number
  private _deactivationThreshold: number
  private _gritPriority: number
  private _gritPatienceScale: number
  private _frustrationTolerance: number
  private _epistemicBeliefThreshold: number

  private _goals = new Map<string, GoalState>()
  private _goalCounter = 0
  /** Updated every tick — used as the baseline for newly created goals. */
  private _currentBeliefCount = 0
  /** IDs of goals for which goal.achieved has already been published, so we
   *  don't re-fire the event on every subsequent tick. */
  private _achievedGoalIds = new Set<string>()
  /** IDs of goals for which goal.completed has already been emitted. Same
   *  once-per-goal guard as _achievedGoalIds — completedGoals accumulates across
   *  ticks, so without this the event re-fires every tick for every completed
   *  goal (the goal-completion churn). */
  private _completedEmittedIds = new Set<string>()

  // ── Blocked-goal detection ─────────────────────────────────
  private _goalLastProgress = new Map<string, number>()  // goalId → last progress
  private _goalStuckSince   = new Map<string, Tick>()    // goalId → tick stuck began

  private _energyLevel: number = 100
  private _sleepPressure: number = 0
  private _stressLoad: number = 0
  private _executiveGoalConfidence: number = 0.5

  /** Tracks current simulation tick so addGoal() can stamp activatedAt correctly. */
  private _currentTick: Tick = 0

  private _bus: CognitiveBus | null = null
  private _sessionLogger: SessionLogger | null = null

  private readonly _model = new GenerativeModel()


  attachSessionLogger( logger: SessionLogger | null ): void {
    this._sessionLogger = logger
  }

  constructor( config: GoalManagerConfig = {} ){
    this._bus = config.bus ?? null
    this._maxActiveGoals          = config.maxActiveGoals          ?? 5
    this._priorityDecayRate       = config.priorityDecayRate       ?? 0.005
    this._basePriorityDecayRate   = this._priorityDecayRate
    this._deactivationThreshold   = config.deactivationThreshold   ?? 0.1
    this._gritPriority            = config.gritPriority            ?? 0.8
    this._gritPatienceScale       = config.gritPatienceScale       ?? 2
    this._frustrationTolerance    = config.frustrationTolerance    ?? 0.5
    this._epistemicBeliefThreshold = config.epistemicBeliefThreshold ?? 8
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  private readonly _STUCK_THRESHOLD = 20  // ticks without progress before "blocked"

  subscribes(): string[] {
    return [
      'energy.state.changed',
      'sleep.state.changed',
      'stress.state.changed',
      'belief.updated',
      'executive.goal.proposed',
      'executive.prediction.formed',
      'executive.facet.progress',
      'plan.completed',
      'action.outcome',   // 4.1: advance action-type goals when matching outcomes fire
    ]
  }
  publishes(): CognitiveEventSchema[] {
    return [
      { type: 'goal.blocked',   version: 1, validate: () => null },
      { type: 'goal.achieved',  version: 1, validate: () => null },
      { type: 'goal.abandoned', version: 1, validate: () => null },
    ]
  }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    switch( e.type ){
      case 'energy.state.changed':
        this._energyLevel = (e.payload as Record<string,number>)['level'] ?? this._energyLevel
        break
      case 'sleep.state.changed':
        this._sleepPressure = (e.payload as Record<string,number>)['pressure'] ?? this._sleepPressure
        break
      case 'stress.state.changed':
        this._stressLoad = (e.payload as Record<string,number>)['load'] ?? this._stressLoad
        break
      case 'belief.updated':
        // Salience model only — authoritative count always read from state.metrics.
        this._model.observe( 'belief.count', ( e.payload as Record<string,number> )['total'] ?? 0 )
        break
      case 'executive.goal.proposed':
        // Track that executive proposed goals — prioritize executive-sourced goals slightly higher
        this._executiveGoalConfidence = (e.payload as Record<string,number>)['confidence'] ?? 0.5
        break
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if (p.predictedDomains.includes('executive'))
          this._model.setPrecision('goal.active_count', 1.0 + p.confidence * 0.5)
        break
      }
      case 'executive.facet.progress': {
        const payload = e.payload as {
          facetId?: string
          planId?: string
          goalId?: string
          goalProgress?: number
          newGoals?: Array<{
            description: string; priority: number; tags: string[]
            completionType: string; completionCondition?: string
          }>
          goalsToAbandon?: Array<{ goalId: string; reason: string }>
          newBeliefs?: Array<{
            statement: string; category: string; confidence: number
            evidence: 'single_observation' | 'recurring_pattern' | 'strong_pattern'; tags: string[]
          }>
        }

        // Forward new goals to GoalManager
        if( payload.newGoals )
          for( const goal of payload.newGoals )
            this.addGoal(
              goal.description,
              goal.priority,
              goal.tags,
              undefined,
              undefined,
              goal.completionType as 'action',
              goal.completionCondition
            )

        // Forward goal abandonments
        if( payload.goalsToAbandon )
          for( const ga of payload.goalsToAbandon )
            this.abandonGoal( ga.goalId, ga.reason )
          
        if( payload.goalId && payload.goalProgress !== undefined ){
          const goal = this._goals.get( payload.goalId )
          if( goal?.status === 'active' ){
            goal.progress = Math.max( goal.progress, payload.goalProgress )  // forward-only
            if( goal.progress >= 0.95 )
              goal.status = 'pending_verification'
          }
        }

        break
      }
      case 'plan.completed': {
        const
        p = e.payload as { goalId: string },
        goal = this._goals.get( p.goalId )

        if( goal?.status === 'active' )
          goal.status = 'pending_verification'  // queued for condition eval next tick

        break
      }
      case 'action.outcome': {
        // 4.1: advance action-type goals when a real outcome matches their domain/tags.
        // Epistemic/metric goals are advanced by their own mechanisms (_updateProgress).
        const p = e.payload as { actionType: string; domain: string; outcomeQuality: number }
        this._nudgeActionGoals( p.domain, p.actionType, p.outcomeQuality )
        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      energyLevel:    this._energyLevel,
      sleepPressure:  this._sleepPressure,
      stressLoad:     this._stressLoad,
    }
  }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { set: [], delete: [], metrics: [] }

    // Refresh personality dispositions from the engine-config mirror (base ⊕
    // persona-prior) so grit/persistence reflect both the PMA seed and metacognitive
    // self-tuning over time — not hardcoded constants.
    this._readConfigFromState( state )

    // 0a. Snapshot current tick and belief count.
    //     Belief count is read directly from state.metrics — the only reliable source.
    //     The bus event (memory.state.changed) used to carry this but the payload field
    //     never matched; we now read the metric directly to avoid the stale-zero problem.
    this._currentTick        = tick
    this._currentBeliefCount = state.metrics.get('memory.beliefs_total') ?? 0

    // 0b. Sync goals seeded into state (e.g. bootstrap goals or LLM-generated goals)
    this._syncFromStateGoals( state, tick )

    // 1. Scan drives for new goal activation
    this._activateFromDrives( state, tick )

    // 2. Scan percepts for externally triggered goals
    this._activateFromPercepts( state, tick )

    // 3. Update priorities based on drive intensity and context
    this._updatePriorities( state )

    // 4. Check progress from state changes
    this._updateProgress( state, tick )

    // 5. Resolve goal conflicts (highest priority wins)
    this._resolveConflicts()

    // 6. Deactivate goals below threshold
    this._deactivateStale( tick, state )

    // 7. Persist goals as entities
    this._persistGoals( commands, tick )

    // 8. Metrics
    const
    activeGoals = Array.from( this._goals.values() ).filter( g => g.status === 'active'),
    completedGoals = Array.from( this._goals.values() ).filter( g => g.status === 'completed')

    const avgProgress = activeGoals.length > 0
      ? activeGoals.reduce( ( s, g ) => s + g.progress, 0 ) / activeGoals.length
      : 0

    commands.metrics!.push(
      [ 'goals.active',          activeGoals.length ],
      [ 'goals.completed_total', completedGoals.length ],
      [ 'goals.total',           this._goals.size ],
      [ 'goals.top_priority',    activeGoals[0]?.priority ?? 0 ],
      [ 'goals.avg_progress',    avgProgress ],
    )

    // Goal completion events — once per goal, on the completion transition.
    // completedGoals accumulates across ticks; the _completedEmittedIds guard
    // stops this re-firing every tick for every completed goal.
    for( const goal of completedGoals )
      if( goal.progress >= 1 && !this._completedEmittedIds.has( goal.id ) ){
        this._completedEmittedIds.add( goal.id )
        events.push({
          type: 'goal.completed',
          source: this.name,
          payload: { goalId: goal.id, description: goal.description },
        })
      }

    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus && activeGoals.length >= 0 )
      _bus.publish({
        type: 'goal.state.changed',
        version: 1,
        sourceEngine: this.name,
        salience: Math.max( 0.4, this._model.observe( 'goal.active_count', activeGoals.length ).salience ),
        payload: { activeCount: activeGoals.length }
      })

    // Publish goal.achieved once per newly completed goal.
    // Uses _achievedGoalIds to ensure the event fires exactly once per goal
    // (completedGoals accumulates across ticks and would otherwise re-fire every tick).
    if( _bus )
      for( const goal of completedGoals )
        if( !this._achievedGoalIds.has( goal.id ) ){
          this._achievedGoalIds.add( goal.id )
          const timeToComplete = tick - goal.activatedAt

          _bus.publish({
            type: 'goal.achieved', version: 1, sourceEngine: this.name,
            salience: Math.min( 1, 0.5 + goal.priority * 0.5 ),
            payload: { goalId: goal.id, description: goal.description, priority: goal.priority, timeToComplete },
          })
        }

    // Detect newly-blocked goals and fire one event per goal on the transition tick
    _bus && this._detectBlockedGoals( tick, activeGoals, _bus )

    return { events: events.length > 0 ? events : undefined, commands }
  }

  private _detectBlockedGoals( tick: Tick, activeGoals: GoalState[], bus: CognitiveBus ): void {
    for( const goal of activeGoals ){
      const lastProgress = this._goalLastProgress.get( goal.id )

      if( lastProgress !== undefined && Math.abs( goal.progress - lastProgress ) < 0.001 ){
        // No progress change — increment stuck counter
        if( !this._goalStuckSince.has( goal.id ) )
          this._goalStuckSince.set( goal.id, tick )

        const
        stuckSince = this._goalStuckSince.get( goal.id )!,
        ticksStuck = tick - stuckSince

        // Fire on every _STUCK_THRESHOLD crossing so subscribers get
        // escalating ticksStuck values (20, 40, 60...) and can detect resolution
        // when events stop arriving.
        if( ticksStuck > 0 && ticksStuck % this._STUCK_THRESHOLD === 0 )
          bus.publish({
            type: 'goal.blocked', version: 1, sourceEngine: this.name,
            salience: Math.min( 1, 0.5 + goal.priority * 0.5 ),
            payload: { goalId: goal.id, ticksStuck, priority: goal.priority },
          })
      }
      // Progress moved — clear stuck state and log significant shifts
      else {
        this._goalStuckSince.delete( goal.id )
        if( lastProgress !== undefined && Math.abs( goal.progress - lastProgress ) >= 0.05 ){
          this._sessionLogger?.write({
            type:         'goal.progress',
            tick:         tick as unknown as number,
            goalId:       goal.id,
            description:  goal.description,
            previousProgress: lastProgress,
            newProgress:  goal.progress,
            delta:        goal.progress - lastProgress,
          } as any)
        }
      }

      this._goalLastProgress.set( goal.id, goal.progress )
    }

    // Clean up trackers for goals that are no longer active
    for( const id of this._goalStuckSince.keys() )
      if( !activeGoals.find( g => g.id === id ) ){
        this._goalStuckSince.delete( id )
        this._goalLastProgress.delete( id )
      }
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Add a goal to the manager.
   */
  addGoal(
    description: string,
    basePriority: number,
    tags: string[] = [],
    parentGoalId?: string,
    deadline?: Tick,
    completionType: GoalState['completionType'] = 'epistemic',
    completionCondition?: string,
    id?: string,
    requestingEntityId?: string,
    requestingThreadId?: string,
  ): string {
    this._goalCounter++
    const goalId = id ?? `goal-${this._goalCounter}`

    this._goals.set( goalId, {
      id: goalId,
      description,
      priority: basePriority,
      basePriority,
      progress: 0,
      status: 'active',
      parentGoalId,
      subGoals: [],
      activatedAt: this._currentTick,
      deadline,
      tags,
      beliefsAtActivation: this._currentBeliefCount,
      completionType,
      completionCondition,
      requestingEntityId,
      requestingThreadId
    })

    if( parentGoalId ){
      const parent = this._goals.get( parentGoalId )
      if( parent ) parent.subGoals.push( goalId )
    }

    return goalId
  }

  /**
   * Get all active goals sorted by priority.
   */
  getActiveGoals(): GoalState[] {
    return Array.from( this._goals.values() )
                .filter( g => g.status === 'active')
                .sort( ( a, b ) => b.priority - a.priority )
  }

  getGoal( id: string ): GoalState | undefined {
    return this._goals.get( id )
  }

  /**
   * Mark a goal as completed.
   */
  completeGoal( goalId: string ): void {
    const goal = this._goals.get( goalId )
    if( goal ){
      goal.status = 'completed'
      goal.progress = 1

      this._sessionLogger?.write({
        type:        'goal.achieved',
        tick:        this._currentTick as unknown as number,
        goalId:      goal.id,
        description: goal.description,
        priority:    goal.priority,
        activatedAt: goal.activatedAt as unknown as number,
        age:         ( this._currentTick as unknown as number ) - ( goal.activatedAt as unknown as number ),
      } as any)

      // Cascade completion to parent
      if( goal.parentGoalId ){
        const parent = this._goals.get( goal.parentGoalId )
        if( parent && parent.subGoals.every( sgId => this._goals.get( sgId )?.status === 'completed') ){
          parent.progress = 1
          parent.status = 'completed'
        }
      }
    }
  }

  /**
   * Abandon a goal with an optional reason.
   */
  abandonGoal( goalId: string, reason?: string ): void {
    const goal = this._goals.get( goalId )
    if( goal && goal.status === 'active' ){
      goal.status = 'abandoned'
      // Optionally store the reason (if GoalState had a reason field; we can add it or store in tags)
      reason && goal.tags.push(`abandoned:${reason.slice(0,50)}`)

      this._sessionLogger?.write({
        type:        'goal.abandoned',
        tick:        this._currentTick as unknown as number,
        goalId:      goal.id,
        description: goal.description,
        priority:    goal.priority,
        progress:    goal.progress,
        reason:      reason?.slice( 0, 200 ),
        age:         ( this._currentTick as unknown as number ) - ( goal.activatedAt as unknown as number ),
      } as any)

      // Bus signal so the PlanningEngine can cancel any plans pursuing this goal
      // (previously abandonment was session-log only — plans ran on regardless).
      this._bus?.publish({
        type: 'goal.abandoned', version: 1, sourceEngine: this.name,
        salience: 0.55,
        payload: { goalId: goal.id, reason: reason?.slice( 0, 200 ) },
      })
    }
  }

  /**
   * Update a goal's priority.
   */
  updateGoalPriority( goalId: string, newPriority: number ): void {
    const goal = this._goals.get( goalId )
    if( goal && goal.status === 'active')
      goal.priority = Math.max( 0, Math.min( 1, newPriority ) )
  }
  
  // ── Internal: activation ─────────────────────────────────

  private _syncFromStateGoals( state: ReadonlySimulationState, tick: Tick ): void {
    for( const entity of state.entities.values() ){
      if( entity.type !== 'goal') continue
      if( this._goals.has( entity.id ) ) continue

      const meta = entity.metadata ?? {}

      const status = ( meta.status as GoalState['status'] ) ?? 'active'
      if( status === 'completed' || status === 'abandoned') continue

      this._goals.set( entity.id, {
        id:                  entity.id,
        description:         ( meta.description          as string )   ?? entity.id,
        priority:            ( meta.priority              as number )   ?? 0.5,
        basePriority:        ( meta.basePriority          as number )   ?? ( meta.priority as number ) ?? 0.5,
        progress:            ( meta.progress              as number )   ?? 0,
        status,
        parentGoalId:        meta.parentGoalId as string | undefined,
        subGoals:            ( meta.subGoals              as string[] ) ?? [],
        activatedAt:         ( meta.activatedAt as Tick ) ?? tick,
        deadline:            meta.deadline as Tick | undefined,
        tags:                ( meta.tags                  as string[] ) ?? [],
        beliefsAtActivation: ( meta.beliefsAtActivation   as number )   ?? this._currentBeliefCount,
        completionType:      ( meta.completionType as GoalState['completionType'] ) ?? 'epistemic',
        completionCondition: meta.completionCondition as string | undefined,
      })
    }
  }

  private _activateFromDrives( state: ReadonlySimulationState, _tick: Tick ): void {
    const driveMappings: Array<{
      drive: string; threshold: number
      goalDesc: string; priority: number; tags: string[]
      completionType?: GoalState['completionType']   // defaults to 'metric'
      completionCondition?: string                   // metric goals only
    }> = [
      { drive: 'drive.energy',           threshold: 0.4, goalDesc: 'Replenish energy',       priority: 0.7, tags: [ 'survival', 'energy' ],     completionCondition: 'energy.level > 70'     },
      { drive: 'drive.sleep',            threshold: 0.5, goalDesc: 'Find rest opportunity',  priority: 0.8, tags: [ 'survival', 'sleep'  ],     completionCondition: 'sleep.pressure < 20'   },
      { drive: 'drive.stress_reduction', threshold: 0.4, goalDesc: 'Reduce stress load',     priority: 0.6, tags: [ 'wellbeing', 'stress' ],    completionCondition: 'stress.load < 40'      },
      // `emotion.boredom` is a 0–1 metric (aesthetic.evaluator); the drive fires when it is
      // sustained above 0.6, so the goal resolves once it falls back under 0.4 — a real
      // hysteresis band, not the old `< 40` (always-true on a 0–1 scale → born-done loop).
      { drive: 'drive.seek_engagement',  threshold: 0.5, goalDesc: 'Seek stimulating engagement — reach out, explore, create, or learn something new to break the monotony', priority: 0.55, tags: [ 'engagement', 'boredom' ], completionCondition: 'emotion.boredom < 0.4' },
      // Curiosity-to-resolve (Phase 3.a): a familiar-yet-unknown someone the Will keeps
      // meeting generates an epistemic pull — "get to know them". Epistemic, so it resolves
      // as the Will *learns* (belief formation, incl. keid-tagged beliefs from conversation),
      // rather than against a metric threshold.
      { drive: 'drive.curiosity_resolve', threshold: 0.4, goalDesc: 'Get to know the people I keep encountering but barely know', priority: 0.45, tags: [ 'curiosity', 'knowledge' ], completionType: 'epistemic' },
    ]

    for( const mapping of driveMappings ){
      const driveIntensity = state.metrics.get( mapping.drive ) ?? 0
      if( driveIntensity < mapping.threshold ) continue

      const existing = Array.from( this._goals.values() )
                            .find( g => {
                              return g.tags.includes( mapping.tags[0]! )
                                      && g.tags.includes( mapping.tags[1]! )
                                      && g.status === 'active'
                            })

      // Never spawn a goal that is *already satisfied* — it would complete on its
      // creation tick and respawn the next, forever (a goal born done). Only create when
      // there is genuine work toward the completion condition. (Guards a real drive/metric
      // threshold mismatch found in a session log: seek-engagement spawned while
      // `emotion.boredom < 40` was already true, producing one age-0 "achievement" per tick.)
      if( !existing && !this._isConditionMet( mapping.completionCondition, state ) )
        this.addGoal( mapping.goalDesc, mapping.priority, mapping.tags, undefined, undefined, mapping.completionType ?? 'metric', mapping.completionCondition )
    }
  }

  private _activateFromPercepts( state: ReadonlySimulationState, _tick: Tick ): void {
    for( const entity of state.entities.values() )
      if( entity.type === 'attention.demand' && entity.metadata?.generatesGoal ){
        const m    = entity.metadata
        const desc = ( m.goalDescription as string ) ?? 'Respond to demand'
        // A demand may carry its own goal shape (tags / completion) — e.g. the per-entity
        // curiosity pull from known.entity.tracker, an epistemic/metric goal keyed to one
        // referent. Defaults preserve the original external-action-demand behaviour.
        const tags    = ( m.goalTags as string[] ) ?? [ 'external', 'demand' ]
        const cType   = ( m.goalCompletionType as GoalState['completionType'] ) ?? 'action'
        const cCond   = m.goalCompletionCondition as string | undefined
        // Dedup by the referent (keid: tag) when present, else by description.
        const keidTag = tags.find( t => t.startsWith( 'keid:' ) )
        const existing = Array.from( this._goals.values() ).find( g =>
          g.status === 'active' && ( keidTag ? g.tags.includes( keidTag ) : g.description === desc ) )

        // Don't spawn a goal that's already satisfied (born-done guard — see _activateFromDrives).
        if( !existing && !this._isConditionMet( cCond, state ) )
          this.addGoal( desc, ( m.goalPriority as number ) ?? 0.5, tags, undefined, undefined, cType, cCond )
      }
  }

  // ── Internal: priority ───────────────────────────────────

  private _updatePriorities( state: ReadonlySimulationState ): void {
    // Task-persistence: which goal the Will is focused on + how committed (task.switcher)
    // and the (developable) cost of switching away. Drives the commitment boost below.
    const focusMeta     = state.entities.get( 'task-switch-focus' )?.metadata as Record<string, unknown> | undefined
    const focusedGoalId = focusMeta?.goalId as string | undefined
    const focusTicks    = ( focusMeta?.focusTicks as number ) ?? 0
    const switchCost    = state.metrics.get( 'task_switch.switch_cost' ) ?? 0

    for( const goal of this._goals.values() ){
      if( goal.status !== 'active') continue

      // Commitment boost — only the focused goal, bounded, never accumulating. Builds with
      // focus duration, amplified by sunk cost in an in-progress plan, scaled by switch cost.
      let commitmentBoost = 0
      if( goal.id === focusedGoalId && focusTicks > 0 && switchCost > 0 ){
        const commitment  = Math.min( 1, focusTicks / FOCUS_COMMITMENT_RAMP )
        const planProgress = this._focusedPlanProgress( state, goal.id )
        commitmentBoost = Math.min(
          MAX_COMMITMENT_BOOST,
          switchCost * commitment * ( 1 + planProgress ) * COMMITMENT_GAIN
        )
      }

      // Drive-aligned goals get priority boost from drive intensity
      let driveBoost = 0
      if( goal.tags.includes('energy') )
        driveBoost += ( state.metrics.get('drive.energy') ?? 0 ) * 0.3

      if( goal.tags.includes('sleep') )
        driveBoost += ( state.metrics.get('drive.sleep') ?? 0 ) * 0.3

      if( goal.tags.includes('engagement') )
        driveBoost += ( state.metrics.get('drive.seek_engagement') ?? 0 ) * 0.25

      // Deadline pressure: boost before deadline, decay faster after
      let deadlineBoost = 0
      if( goal.deadline ){
        const ticksUntilDeadline = ( goal.deadline as unknown as number ) - ( this._currentTick as unknown as number )
        if( ticksUntilDeadline > 0 ){
          // Urgency ramps linearly in the last 50 ticks before deadline
          const urgency = Math.max( 0, 1 - ticksUntilDeadline / 50 )
          deadlineBoost = urgency * 0.4
        } else {
          // Overdue: decay priority 3× faster — stale goals should yield to fresh ones
          deadlineBoost = -this._priorityDecayRate * 2
        }
      }

      // Decay priority toward base
      goal.priority = goal.basePriority
                    + driveBoost
                    + deadlineBoost
                    + commitmentBoost
                    - this._priorityDecayRate

      goal.priority = Math.max( 0, Math.min( 1, goal.priority ) )
    }
  }

  /**
   * Plan completion (0..1) for a goal, read from the live `plan` entity (planning.engine).
   * Sunk cost: a goal with a half-finished plan is costlier to abandon, so it amplifies the
   * task-persistence commitment boost. 0 when the goal has no plan or an empty one.
   */
  private _focusedPlanProgress( state: ReadonlySimulationState, goalId: string ): number {
    for( const e of state.entities.values() ){
      if( e.type !== 'plan' || e.metadata?.goalId !== goalId ) continue
      const steps = ( e.metadata?.steps as Array<{ status?: string }> | undefined ) ?? []
      if( steps.length === 0 ) continue
      const done = steps.filter( s => s.status === 'completed' || s.status === 'skipped' ).length
      return done / steps.length
    }
    return 0
  }

  private _resolveConflicts(): void {
    const active = this.getActiveGoals()

    // Deactivate lowest-priority goals if over capacity
    while( active.length > this._maxActiveGoals ){
      const lowest = active.pop()
      if( lowest ) lowest.status = 'pending'
    }
  }

  // ── Internal: progress ───────────────────────────────────

  private _updateProgress( state: ReadonlySimulationState, tick: Tick ): void {
    // Read from state.metrics — authoritative, updated every tick by semantic integrator.
    const currentBeliefs = state.metrics.get('memory.beliefs_total') ?? 0

    for( const goal of this._goals.values() ){
      // A goal cannot be born and die in the same tick. Give it at least one tick to be
      // worked on before it can complete — this kills age-0 "achievements" universally
      // (defence-in-depth beyond the already-satisfied creation guard in _activateFromDrives).
      if( goal.activatedAt === tick ) continue

      if( goal.status === 'pending_verification' ){
        const met = this._evaluateMetricProgress( goal, state ) >= 1
        met ? this.completeGoal( goal.id ) : ( goal.status = 'active' )

        continue  // skip completionType switch entirely
      }

      if( goal.status !== 'active' && goal.status !== 'blocked' ) continue

      switch( goal.completionType ){
        case 'metric':
          goal.progress = this._evaluateMetricProgress( goal, state )
          break

        case 'action':
          // Progress is advanced externally via onCognitiveEvent('action.outcome')
          // → _nudgeActionGoals().  _updateProgress() only checks for completion here.
          // _deactivateStale abandons it if stuck for too long under frustration.
          break

        case 'epistemic':
        default: {
          const newBeliefs = currentBeliefs - goal.beliefsAtActivation
          goal.progress = Math.min( 1, newBeliefs / this._epistemicBeliefThreshold )
          break
        }
      }

      goal.progress >= 1 && this.completeGoal( goal.id )
    }
  }

  /**
   * Evaluate progress for a metric goal.
   *
   * If the goal has a completionCondition (e.g. "stress.load < 40"), parse and
   * compute smooth 0-1 progress toward it. Falls back to tag-based heuristics
   * for the three built-in drive metrics when no condition is specified.
   */

  /**
   * 4.1: Nudge progress on `action`-type goals when an action.outcome event fires
   * whose domain or actionType overlaps with the goal's tags.
   *
   * Progress is incremented by `outcomeQuality × 0.12` per matched action, so
   * a goal with a single matching tag needs ~9 successful actions (at full quality)
   * to complete — a realistic bar for discrete, real-world tasks.
   *
   * Substring matching (both directions) handles common mismatches between
   * effector names and goal tags (e.g. "communicate" ↔ "communication",
   * "learn" ↔ "learning").
   */
  private _nudgeActionGoals(
    domain:         string,
    actionType:     string,
    outcomeQuality: number
  ): void {
    const dLow = domain.toLowerCase()
    const aLow = actionType.toLowerCase()

    // Communication actions — 'talk' and 'text' are always treated as
    // matching the 'communication' and 'reply' tag families so goals created
    // in response to incoming messages get their progress nudged.
    const isCommunicationAction = aLow === 'talk' || aLow === 'text'
                                || dLow === 'communication'

    for( const goal of this._goals.values() ){
      if( goal.status !== 'active' && goal.status !== 'blocked' ) continue
      if( goal.completionType !== 'action' ) continue

      const hasMatch = goal.tags.some( tag => {
        const t = tag.toLowerCase()
        return t === dLow
            || t === aLow
            || dLow.includes( t ) || t.includes( dLow )
            || aLow.includes( t ) || t.includes( aLow )
      }) || ( isCommunicationAction && goal.tags.some( t =>
        t === 'communication' || t === 'reply' || t === 'conversation'
      ) )

      if( hasMatch ){
        goal.progress = Math.min( 1, goal.progress + outcomeQuality * 0.12 )
        goal.lastActionAttemptTick = this._currentTick
        goal.lastActionType        = actionType
      }
    }
  }

  /** True when a metric completionCondition (e.g. "emotion.boredom < 40") is already met. */
  private _isConditionMet( condition: string | undefined, state: ReadonlySimulationState ): boolean {
    if( !condition ) return false
    const m = condition.match( /^([\w.]+)\s*([<>]=?)\s*([\d.]+)$/ )
    if( !m ) return false
    const [ , key, op, raw ] = m
    const current   = state.metrics.get( key! ) ?? 0
    const threshold = parseFloat( raw! )
    return op === '<'  ? current <  threshold
         : op === '<=' ? current <= threshold
         : op === '>'  ? current >  threshold
         :               current >= threshold
  }

  private _evaluateMetricProgress(
    goal: GoalState,
    state: ReadonlySimulationState
  ): number {
    if( goal.completionCondition ){
      const m = goal.completionCondition.match( /^([\w.]+)\s*([<>]=?)\s*([\d.]+)$/ )
      if( m ){
        const [ , key, op, rawThreshold ] = m
        const current   = state.metrics.get( key! ) ?? 0
        const threshold = parseFloat( rawThreshold! )

        const met = op === '<'  ? current <  threshold
                  : op === '<=' ? current <= threshold
                  : op === '>'  ? current >  threshold
                  :               current >= threshold

        if( met ) return 1

        // Smooth gradient toward the threshold. Infer the metric's range from the threshold:
        // ≤ 1 ⇒ a 0–1 metric (e.g. emotion.boredom), otherwise the 0–100 default. Clamped.
        const scale = threshold <= 1 ? 1 : 100
        return op === '<' || op === '<='
                  ? Math.max( 0, Math.min( 1, ( scale - current ) / ( scale - threshold ) ) )
                  : Math.max( 0, Math.min( 1, current / threshold ) )
      }
    }

    // Tag-based fallback for the three built-in drive metrics
    if( goal.tags.includes('energy') )
      return Math.min( 1, this._energyLevel / 100 )
    
    if( goal.tags.includes('sleep') )
      return Math.max( 0, 1 - ( this._sleepPressure ) / 100 )
    
    if( goal.tags.includes('stress') )
      return Math.max( 0, 1 - this._stressLoad / 100 )

    return goal.progress  // no update if no condition and no known tag
  }

  /**
   * Refresh personality-derived dispositions from `engine-config-goal-manager`
   * (base params ⊕ persona-prior deltas). Grit/persistence is a per-Will trait
   * seeded by the PMA and developed by the metacognition cycle — not a constant.
   */
  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const p = readEffectiveParams( state, 'engine-config-goal-manager' )
    if( p.gritPriority         != null ) this._gritPriority         = p.gritPriority
    if( p.gritPatienceScale    != null ) this._gritPatienceScale    = p.gritPatienceScale
    if( p.frustrationTolerance != null ) this._frustrationTolerance = p.frustrationTolerance
  }

  private _deactivateStale( tick: Tick, state: ReadonlySimulationState ): void {
    // Frustration compresses the patience window — but frustrationTolerance (a
    // personality trait) dampens that, so a resilient mind doesn't give up faster
    // just because it's frustrated.
    const tol          = Math.max( 0, Math.min( 1, this._frustrationTolerance ) )
    const frustration  = ( state.metrics.get('emotion.frustration') ?? 0 ) * ( 1 - tol )
    const patienceTicks = frustration > 0.6
      ? 80    // gave up quickly under high (tolerance-adjusted) frustration
      : frustration > 0.3
        ? 130  // moderate impatience
        : 200  // default — full patience window

    for( const goal of this._goals.values() ){
      if( goal.status !== 'active') continue
      if( goal.priority < this._deactivationThreshold ){
        goal.status = 'abandoned'
        continue
      }

      // Resilience / grit: importance buys persistence. A sufficiently important goal
      // is NEVER auto-abandoned by staleness — the mind only lets it go by a deliberate
      // executive decision (goalsToAbandon). What matters isn't dropped by a timer.
      if( goal.priority >= this._gritPriority ) continue

      // Below the grit threshold, patience scales with priority — a more-important
      // stuck goal is pursued much longer before the mind gives up on it.
      const scaledPatience = patienceTicks * ( 1 + goal.priority * this._gritPatienceScale )
      const age = tick - goal.activatedAt
      if( age > scaledPatience && goal.progress < 0.1 )
        goal.status = 'abandoned'
    }
  }

  // ── Internal: persistence ────────────────────────────────

  private _persistGoals( commands: StateCommands, tick: Tick ): void {
    for( const goal of this._goals.values() )
      commands.set!.push({
        id: goal.id,
        type: 'goal',
        updatedAt: tick,
        metadata: {
          description:          goal.description,
          priority:             goal.priority,
          basePriority:         goal.basePriority,
          progress:             goal.progress,
          status:               goal.status,
          parentGoalId:         goal.parentGoalId,
          subGoals:             goal.subGoals,
          deadline:             goal.deadline,
          tags:                 goal.tags,
          beliefsAtActivation:  goal.beliefsAtActivation,
          completionType:       goal.completionType,
          completionCondition:  goal.completionCondition,
          activatedAt:          goal.activatedAt,
          tick,
        },
      })
  }
}
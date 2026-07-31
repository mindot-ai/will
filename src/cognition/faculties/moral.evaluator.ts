// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/moral.evaluator.ts
// ─────────────────────────────────────────────────────────────

/**
 * MoralEvaluator — compares actions against internalized values and norms.
 *
 * Evaluates:
 *   - Own actions against personal standards
 *   - Others' actions against social norms
 *   - Value alignment and violation
 *   - Social comparison (am I better/worse than my standards?)
 *
 * Produces: guilt, shame, pride, indignation, disgust
 *
 * Guilt = "I did something bad" (action-focused, private)
 * Shame = "I am bad" (self-focused, social exposure)
 * Pride = "I did something good" (achievement against standards)
 * Indignation = "They did something wrong" (moral anger at others)
 * Disgust = "That violates a sacred value" (visceral moral rejection)
 *
 * Requires a value system — initialized with basic moral foundations
 * and extensible through learning.
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
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
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

export interface MoralEvaluatorConfig {
  /** Moral foundations and their weights */
  foundations?: Record<string, number>
  /** Threshold for moral emotions to trigger events */
  eventThreshold?: number
  /** Rate at which moral emotions decay without re-trigger */
  decayRate?: number
  bus?: CognitiveBus
}

/**
 * Moral Foundations Theory — six core dimensions.
 * Each foundation has a care/harm and fairness/cheating polarity.
 */
interface MoralFoundation {
  name: string
  weight: number       // How much this foundation matters to the agent
  threshold: number    // Sensitivity — how easily triggered
}

interface ValueViolation {
  foundation: string
  severity: number     // 0-1: how severe the violation
  agent: 'self' | 'other'
  keid: string
}

export class MoralEvaluator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'moral-evaluator'
  
  private _foundations: MoralFoundation[]
  private _eventThreshold: number
  private _decayRate: number

  // Track own action history for guilt/pride evaluation
  private _recentOwnActions: Array<{
    action: string
    outcome: string
    tick: number
    valueAlignment: Record<string, number>
  }> = []

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: MoralEvaluatorConfig = {} ){
    this._bus = config.bus ?? null
    const foundationWeights = config.foundations ?? {
      care:      0.25,  // Harm/care — protection of vulnerable
      fairness:  0.25,  // Cheating/fairness — proportional outcomes
      loyalty:   0.15,  // Betrayal/loyalty — group commitment
      authority: 0.10,  // Subversion/authority — respect for tradition/order
      sanctity:  0.10,  // Degradation/sanctity — purity/disgust
      liberty:   0.15,  // Oppression/liberty — freedom from domination
    }

    this._foundations = Object.entries( foundationWeights ).map( ([ name, weight ]) => ({
      name,
      weight: weight / Object.values( foundationWeights ).reduce( ( s, w ) => s + w, 0 ),
      threshold: 0.3,
    }))

    this._eventThreshold = config.eventThreshold ?? 0.3
    this._decayRate      = config.decayRate      ?? 0.02
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    // Effective config = base engine-config-moral ⊕ persona-prior. Channel A: a
    // conscientious Will develops a lower eventThreshold and so registers moral
    // self-evaluations (guilt/shame/pride) more readily — the dutifulness facet.
    const p = readEffectiveParams( state, 'engine-config-moral')

    if( p.eventThreshold != null ) this._eventThreshold = p.eventThreshold
    if( p.decayRate != null ) this._decayRate = p.decayRate

    // Update moral foundations from flat params. Keys map 1:1 to the six MFT
    // foundations the engine tracks: the foundation is `sanctity` (carried by
    // `foundationSanctity`, NOT `foundationPurity`), and `liberty` must be
    // carried too — otherwise a state override silently drops both.
    const foundationUpdates: Record<string, number | undefined> = {
      care:      p.foundationCare,
      fairness:  p.foundationFairness,
      loyalty:   p.foundationLoyalty,
      authority: p.foundationAuthority,
      sanctity:  p.foundationSanctity,
      liberty:   p.foundationLiberty,
    }
    let updated = false
    for( const f of this._foundations )
      if( foundationUpdates[ f.name ] != null ){ f.weight = foundationUpdates[ f.name ]!; updated = true }

    // Re-normalize to the constructor's invariant (weights sum to 1.0). The
    // override path previously assigned raw weights directly, de-normalizing
    // the set and skewing the relative weights guilt & indignation depend on.
    if( updated ){
      const total = this._foundations.reduce( ( s, f ) => s + f.weight, 0 )
      if( total > 0 ) for( const f of this._foundations ) f.weight = f.weight / total
    }
  }


  subscribes(): string[] { return ['executive.prediction.formed'] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed'){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('moral') )
        this._model.setPrecision('emotion.guilt', 1.0 + p.confidence * 0.5 )
    }
  }

  snapshot(): Record<string, unknown> { return {} }

  async react(
    delta: Duration,
    _tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._readConfigFromState( state )
    
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { metrics: [] }

    // Detect value violations from percepts and own actions
    const violations = this._detectViolations( state )

    // Categorize violations by target (self vs. other)
    const
    selfViolations   = violations.filter( v => v.agent === 'self'),
    otherViolations  = violations.filter( v => v.agent === 'other')

    // Compute moral emotions
    const previousGuilt = state.metrics.get('emotion.guilt') ?? 0
    const previousShame = state.metrics.get('emotion.shame') ?? 0
    const previousPride = state.metrics.get('emotion.pride') ?? 0

    // Guilt: self-caused harm or fairness violation
    const guiltRaw = this._computeGuilt( selfViolations )
    const guilt = guiltRaw > 0.01
      ? Math.min( 1, guiltRaw )
      : Math.max( 0, previousGuilt - this._decayRate * ( delta / 1000 ) )

    // Shame: self-violation with social exposure
    const shameRaw = this._computeShame( selfViolations, state )
    const shame = shameRaw > 0.01
      ? Math.min( 1, shameRaw )
      : Math.max( 0, previousShame - this._decayRate * ( delta / 1000 ) )

    // Pride: self-exceeding moral standards
    const prideRaw = this._computePride( state )
    const pride = prideRaw > 0.01
      ? Math.min( 1, prideRaw )
      : Math.max( 0, previousPride - this._decayRate * ( delta / 1000 ) )

    // Indignation: others' violations (moral anger)
    const indignation = this._computeIndignation( otherViolations )

    // Disgust: sanctity/degradation violations
    const disgust = this._computeDisgust( violations )

    commands.metrics!.push(
      [ 'emotion.guilt', guilt ],
      [ 'emotion.shame', shame ],
      [ 'emotion.pride', pride ],
      [ 'emotion.indignation', indignation ],
      [ 'emotion.disgust', disgust ],
      [ 'moral.self_violations', selfViolations.length ],
      [ 'moral.other_violations', otherViolations.length ],
    )

    // Significant moral emotion events
    if( guilt > this._eventThreshold )
      events.push({
        type: 'emotion.guilt.significant',
        source: this.name,
        payload: { guilt, selfViolations: selfViolations.map( v => v.foundation ) },
      })

    if( shame > this._eventThreshold )
      events.push({
        type: 'emotion.shame.significant',
        source: this.name,
        payload: { shame },
      })

    if( pride > this._eventThreshold )
      events.push({
        type: 'emotion.pride.significant',
        source: this.name,
        payload: { pride },
      })

    if( indignation > 0.6 )
      events.push({
        type: 'emotion.indignation.elevated',
        source: this.name,
        payload: { indignation },
      })


    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus && ( guilt > 0.4 || shame > 0.4 ) ){
      const predErr = this._model.observe('emotion.guilt', guilt )
      if( !predErr.gated )
        _bus.publish({ type: 'emotion.guilt.elevated', version: 1, sourceEngine: this.name, salience: Math.min(1, guilt * 1.5), payload: { guilt, shame, pride } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Violation detection ──────────────────────────────────

  private _detectViolations( state: ReadonlySimulationState ): ValueViolation[] {
    const violations: ValueViolation[] = []

    for( const entity of state.entities.values() ){
      // Social percepts can encode moral violations
      if( entity.type === 'percept.social'){
        const
        action     = ( entity.metadata?.action as string ) ?? '',
        keid    = ( entity.metadata?.keid as string ) ?? '',
        directedAtSelf = entity.metadata?.directedAtSelf === true,
        harmful    = entity.metadata?.harmful === true,
        unfair     = entity.metadata?.unfair === true,
        deceptive  = entity.metadata?.deceptive === true,
        disrespectful = entity.metadata?.disrespectful === true

        if( harmful )
          violations.push({
            foundation: 'care',
            severity: 0.7,
            agent: directedAtSelf ? 'other' : 'other',
            keid,
          })

        if( unfair )
          violations.push({
            foundation: 'fairness',
            severity: 0.6,
            agent: 'other',
            keid,
          })

        if( deceptive )
          violations.push({
            foundation: 'fairness',
            severity: 0.5,
            agent: 'other',
            keid,
          })

        if( disrespectful )
          violations.push({
            foundation: 'authority',
            severity: 0.4,
            agent: 'other',
            keid,
          })
      }

      // Own actions that could be violations. `decision.record` is what carries
      // them (InhibitionController writes it); an `action.own` alternative was
      // scanned alongside it and never written by anything (#114). Unlike the
      // social/threat host seams, this is an INTERNAL record of the mind's own
      // conduct — not something a host supplies — so the dead half is removed
      // rather than documented.
      if( entity.type === 'decision.record'){
        const
        outcome    = entity.metadata?.outcome as string ?? '',
        harmful    = entity.metadata?.harmful === true,
        unfair     = entity.metadata?.unfair === true,
        dishonest  = entity.metadata?.dishonest === true

        if( harmful )
          violations.push({
            foundation: 'care',
            severity: 0.65,
            agent: 'self',
            keid: 'agent-self',
          })

        if( unfair )
          violations.push({
            foundation: 'fairness',
            severity: 0.55,
            agent: 'self',
            keid: 'agent-self',
          })

        if( dishonest )
          violations.push({
            foundation: 'fairness',
            severity: 0.5,
            agent: 'self',
            keid: 'agent-self',
          })
      }
    }

    return violations
  }

  // ── Emotion computation ──────────────────────────────────

  private _computeGuilt( selfViolations: ValueViolation[] ): number {
    if( selfViolations.length === 0 ) return 0

    // Guilt is weighted by foundation importance
    let weightedSeverity = 0
    let totalWeight = 0

    for( const violation of selfViolations ){
      const foundation = this._foundations.find( f => f.name === violation.foundation )
      const weight = foundation?.weight ?? 0.1
      weightedSeverity += violation.severity * weight
      totalWeight += weight
    }

    return totalWeight > 0 ? weightedSeverity / totalWeight : 0
  }

  private _computeShame(
    selfViolations: ValueViolation[],
    state: ReadonlySimulationState
  ): number {
    if( selfViolations.length === 0 ) return 0

    // Shame = guilt + social exposure
    const guiltLevel = this._computeGuilt( selfViolations )
    const
    socialPresence    = state.metrics.get('social.active_agents') ?? 0,
    evaluationThreat  = state.metrics.get('social.evaluation_threat') ?? 0,
    exposureLevel     = Math.min( 1, ( socialPresence / 5 ) * 0.5 + evaluationThreat * 0.5 )

    return guiltLevel * ( 0.4 + exposureLevel * 0.6 )
  }

  private _computePride( state: ReadonlySimulationState ): number {
    // Pride = own actions exceeded moral standards
    let prideScore = 0
    let actionCount = 0

    for( const entity of state.entities.values() ){
      if( entity.type !== 'decision.record') continue

      const
      virtuous = entity.metadata?.virtuous === true,
      helpful  = entity.metadata?.helpful === true,
      generous = entity.metadata?.generous === true,
      honest   = entity.metadata?.honest === true

      if( virtuous ) prideScore += 0.4
      if( helpful )  prideScore += 0.3
      if( generous ) prideScore += 0.2
      if( honest )   prideScore += 0.1

      actionCount++
    }

    return actionCount > 0
      ? Math.min( 1, prideScore / Math.max( actionCount, 1 ) )
      : 0
  }

  private _computeIndignation( otherViolations: ValueViolation[] ): number {
    if( otherViolations.length === 0 ) return 0

    // Indignation is moral anger at others' violations
    let weightedSeverity = 0
    let totalWeight = 0

    for( const violation of otherViolations ){
      const foundation = this._foundations.find( f => f.name === violation.foundation )
      const weight = foundation?.weight ?? 0.1
      weightedSeverity += violation.severity * weight
      totalWeight += weight
    }

    return totalWeight > 0
      ? Math.min( 1, ( weightedSeverity / totalWeight ) * 1.2 )
      : 0
  }

  private _computeDisgust( violations: ValueViolation[] ): number {
    // Disgust is specifically for sanctity/degradation violations
    const sanctityViolations = violations.filter( v => v.foundation === 'sanctity')
    if( sanctityViolations.length === 0 ) return 0

    const maxSeverity = Math.max( ...sanctityViolations.map( v => v.severity ) )
    return maxSeverity
  }
}
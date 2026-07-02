// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/self.model.updater.ts
// ─────────────────────────────────────────────────────────────

/**
 * SelfModelUpdater — maintains beliefs about own capabilities, traits,
 * and patterns.
 *
 * Periodically evaluates recent performance across domains and updates
 * the will.identity entity with refined self-knowledge. This is how
 * the mind learns "I am good at X, bad at Y" through experience.
 *
 * Uses AsyncEngine — deep self-evaluation may involve LLM introspection.
 *
 * Part of Shard 4 (Meta-Cognitive Layer).
 */

import type {
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  ReasoningFootprint,
  StateCommands,
} from '#core/types'
import { AsyncEngine } from '#core/async.engine'
import type { IntermediateStream } from '#core/async.engine'
import type { SemanticIntegrator, Belief } from '#faculties/semantic.engine/integrator'
import type { CognitiveEngine } from '#cognition/types'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import { GenerativeModel, type GenerativeModelSnapshot } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

/** Shape of the will.identity entity — defined locally to avoid external dependencies. */
interface Keidentity {
  prompt:  string
  values:  string[]
  traits:  Record<string, number>
  style:   string
  version: number
}

/**
 * Per-trait self-knowledge accumulated over the Will's life — the substrate for graded
 * salience options B (baseline-relative) and C (recency). Stored on identity-self
 * beside `traits` and recomputed only at each (infrequent) self-model evaluation, so it
 * changes exactly when identity-self changes — the same cache breakpoint the trait
 * values already ride, adding no extra prompt churn between evaluations. R2-safe:
 * derived purely from state + sim-tick.
 */
export interface TraitStat {
  /** Slow EMA of the trait value — the Will's personal baseline ("my own norm"). */
  mean:      number
  /** Direction of the most recent SIGNIFICANT shift: +1 rising / −1 easing / 0 none. */
  shiftDir:  number
  /** Sim-tick of that shift — drives the eval-aligned recency decay. */
  shiftTick: number
}

// Population baselines seed a fresh Will's personal mean before it has a history of its
// own — this is how Option B's lighter "population" sub-option folds into the personal
// one. 0.5 for all by default; this map is the extension point for a trait with a known
// population prior.
const TRAIT_POPULATION_BASELINE: Record<string, number> = {}
const DEFAULT_TRAIT_BASELINE   = 0.5
const TRAIT_MEAN_EMA_ALPHA     = 0.2   // baseline tracks slowly → "my norm" reflects the sustained level, not a blip
const TRAIT_SHIFT_SIGNIFICANCE = 0.05  // |Δ| at one evaluation to count as a real shift (matches _diffTraits)
const TRAIT_RECENCY_WINDOW     = 600   // ticks a shift stays "lately" (~3 evals at the 200-tick cadence), decayed at an eval

export interface SelfModelUpdaterConfig {
  /** Minimum ticks between self-model evaluations */
  minIntervalTicks?: number
  /** Minimum new experiences before re-evaluating */
  minNewExperiences?: number
  bus?: CognitiveBus
}

// Keyword cues mapping a self-belief statement to the trait(s) it is actually about, so a
// positive self-belief nudges only the relevant trait — NOT every trait. (The prior code
// nudged all traits up indiscriminately, inflating every Channel-A disposition the
// persona-prior reads, regardless of behaviour.) Trait keys match the self-model traits.
const SELF_BELIEF_TRAIT_KEYWORDS: Record<string, string[]> = {
  openness:              [ 'open', 'curious', 'curiosity', 'explore', 'novel' ],
  conscientiousness:     [ 'careful', 'diligent', 'organized', 'thorough', 'responsible', 'disciplined', 'reliable' ],
  agreeableness:         [ 'kind', 'warm', 'helpful', 'caring', 'compassion', 'cooperative', 'friendly', 'gentle' ],
  analytical:            [ 'analytical', 'logical', 'rational', 'reason', 'precise' ],
  creativity:            [ 'creative', 'inventive', 'original', 'imaginative' ],
  persistence:           [ 'persistent', 'determined', 'persevere', 'tenacious', 'driven' ],
  resilience:            [ 'resilient', 'tough', 'recover', 'cope', 'bounce back' ],
  decisiveness:          [ 'decisive', 'confident', 'assertive', 'bold' ],
  'emotional-stability': [ 'calm', 'steady', 'stable', 'composed', 'even-keeled', 'unflappable' ],
}

/** Traits a self-belief statement is plausibly *about*, by keyword cue. Pure. */
export function traitsCuedBySelfBelief( statement: string ): string[] {
  const text = statement.toLowerCase()
  return Object.entries( SELF_BELIEF_TRAIT_KEYWORDS )
    .filter( ( [ , keywords ] ) => keywords.some( k => text.includes( k ) ) )
    .map( ( [ trait ] ) => trait )
}

export class SelfModelUpdater extends AsyncEngine implements CognitiveEngine {
  readonly name     = 'self-model-updater'
  
  private _executiveReflectionBiases: string[] = []
  private _executiveReflectionTick: number = 0
  private _minIntervalTicks: number
  private _minNewExperiences: number

  private _lastEvaluationTick: number = 0
  private _experienceCountAtLastEval: number = 0
  private _cachedEpisodicTotal: number = 0

  // Track domain performance for self-assessment
  private _domainPerformance = new Map<string, Array<{ success: boolean; tick: Tick }>>()

  // Affect-stability self-observation → the evidence behind the 'emotional-stability'
  // trait. A slow EMA of how steady the Will's negative affect has been, sampled every
  // tick in shouldAct. The trait then forms from this the same way task traits form from
  // domain success rates — only here the "behaviour" observed is the Will's own affect.
  private _affectStabilityEma:  number = 0.5
  private _affectObservations:  number = 0

  private _bus: CognitiveBus | null = null
  private _semanticIntegrator: SemanticIntegrator | null = null

  private readonly _model = new GenerativeModel()


  constructor( config: SelfModelUpdaterConfig = {} ){
    // _bus set after super()
    super({
      defaultStrategy: 'FORCE',
      maxPendingTicks: 300,
      logConflicts: false,
      rerunOnRejection: false,
    })

    this._minIntervalTicks   = config.minIntervalTicks   ?? 200
    this._minNewExperiences  = config.minNewExperiences  ?? 20
    this._bus = config.bus ?? null
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  attachSemanticIntegrator( si: SemanticIntegrator ): void { this._semanticIntegrator = si }

  subscribes(): string[] { 
    return [
      'executive.self.reflection',
      'executive.prediction.formed',
      'action.outcome'
    ]
  }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    switch( e.type ){
      case 'executive.self.reflection': {
        const p = e.payload as Record<string, unknown>

        this._executiveReflectionBiases = ( p['identifiedBiases'] as string[] ) ?? []
        this._executiveReflectionTick = ( p['tick'] as number ) ?? 0

        break
      }
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('metacognition') )
          this._model.setPrecision( 'self_model.change', 1.0 + p.confidence * 0.5 )
        
        break
      }
      case 'action.outcome': {
        const p = e.payload as { actionType: string; domain: string; success: boolean; outcomeQuality: number; tick: Tick }
        this.recordOutcome( p.domain, p.success, p.tick )
        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    // FN9: capture the per-domain performance history (the basis for "I am good
    // at X / bad at Y"), the evaluation-gating ticks (so re-evaluation timing
    // replays deterministically — R2), and the salience/generative sub-states.
    return {
      executiveReflectionTick: this._executiveReflectionTick,
      biasCount: this._executiveReflectionBiases.length,
      lastEvaluationTick: this._lastEvaluationTick,
      experienceCountAtLastEval: this._experienceCountAtLastEval,
      domainPerformance: [ ...this._domainPerformance.entries() ].map( ([ k, v ]) => [ k, v.map( r => ({ ...r }) ) ] ),
      model: this._model.snapshot()
    }
  }

  restore( snap: Record<string, unknown> ): void {
    if( !snap ) return

    if( typeof snap.executiveReflectionTick === 'number' ) 
      this._executiveReflectionTick = snap.executiveReflectionTick

    if( typeof snap.lastEvaluationTick === 'number' )
      this._lastEvaluationTick = snap.lastEvaluationTick

    if( typeof snap.experienceCountAtLastEval === 'number' )
      this._experienceCountAtLastEval = snap.experienceCountAtLastEval
    
    if( Array.isArray( snap.domainPerformance ) )
      this._domainPerformance = new Map( snap.domainPerformance as Array<[ string, Array<{ success: boolean; tick: Tick }> ]> )
    
    if( snap.model )
      this._model.restore( snap.model as GenerativeModelSnapshot )
  }

  /**
   * Record an action outcome for domain-specific self-assessment.
   */
  recordOutcome( domain: string, success: boolean, tick: Tick ): void {
    const records = this._domainPerformance.get( domain ) ?? []
    records.push({ success, tick })

    // Keep last 100 records per domain
    if( records.length > 100 ) records.shift()
    this._domainPerformance.set( domain, records )
  }

  // ── AsyncEngine contract ─────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    // Effective config = base engine-config ⊕ persona-prior. This is the first
    // closed edge of the metacognition cycle: a learned prior (written back by
    // the consolidator from the Will's own introspection) modulates how often
    // the self-model re-evaluates, without ever mutating the seeded base.
    const p = readEffectiveParams( state, 'engine-config-self-model' )

    if( p.minIntervalTicks != null ) this._minIntervalTicks = p.minIntervalTicks
    if( p.minNewExperiences != null ) this._minNewExperiences = p.minNewExperiences
  }

  /**
   * Sample current negative affect into a slow EMA — the running self-observation the
   * self-model turns into an 'emotional-stability' trait. Called every tick (in
   * shouldAct), so it tracks affect continuously even between the gated evaluations.
   * Pure/deterministic: the same emotion-metric stream reproduces the same EMA on
   * replay (no wall-clock, no RNG). Stability is read as low sustained negative affect;
   * volatility (variance) would be a finer refinement but a level EMA is enough to drive
   * the self-regulation loop (steadier ⇒ slower frustration build ⇒ steadier).
   */
  private _sampleAffectStability( state: ReadonlySimulationState ): void {
    const negativeAffect = Math.max(
      state.metrics.get('emotion.frustration')  ?? 0,
      state.metrics.get('emotion.anger')        ?? 0,
      state.metrics.get('emotion.irritability') ?? 0,
    )
    const stabilityInstant = Math.max( 0, Math.min( 1, 1 - negativeAffect ) )
    const alpha = 0.05
    this._affectStabilityEma = this._affectObservations === 0
      ? stabilityInstant
      : this._affectStabilityEma * ( 1 - alpha ) + stabilityInstant * alpha
    this._affectObservations++
  }

  protected override shouldAct(
    state: ReadonlySimulationState,
    tick: Tick,
    _context: SimulationContext
  ): boolean {
    this._readConfigFromState( state )
    this._sampleAffectStability( state )

    const
    ticksSinceLast   = tick - this._lastEvaluationTick,
    totalExperiences = state.metrics.get('memory.episodic_total') ?? 0,
    newExperiences   = totalExperiences - this._experienceCountAtLastEval

    this._cachedEpisodicTotal = totalExperiences

    return ticksSinceLast >= this._minIntervalTicks
        && newExperiences >= this._minNewExperiences
  }

  protected override readState(
    state: ReadonlySimulationState,
    tick: Tick
  ): ReasoningFootprint {
    return {
      tickObserved: tick,
      entitiesRead: new Set([ 'identity-self' ]),
      metricsRead: new Set([
        'affect.valence', 'affect.dominance',
        'metacognition.confidence',
      ]),
      entitiesModified: new Set([ 'identity-self' ]),
      intendedCommands: {},
      source: this.name,
    }
  }

  /**
   * Recompute per-trait self-knowledge at an evaluation (Options B/C substrate). Pure +
   * deterministic — sim-tick only. The EMA tracks the personal baseline; a significant Δ
   * this evaluation stamps a recency direction that ages out after TRAIT_RECENCY_WINDOW.
   * The window is checked ONLY here (at evals), so the recency stamp never churns the
   * prompt between evaluations.
   */
  private _computeTraitStats(
    oldTraits: Record<string, number>,
    newTraits: Record<string, number>,
    prevStats: Record<string, TraitStat>,
    evalTick:  number,
  ): Record<string, TraitStat> {
    const stats: Record<string, TraitStat> = {}

    for( const key of Object.keys( newTraits ) ){
      const newVal = newTraits[ key ] ?? DEFAULT_TRAIT_BASELINE
      const oldVal = oldTraits[ key ] ?? newVal
      const prev   = prevStats[ key ]

      // Personal baseline: EMA seeded from the population prior on first sight.
      const seed = prev?.mean ?? ( TRAIT_POPULATION_BASELINE[ key ] ?? DEFAULT_TRAIT_BASELINE )
      const mean = seed + TRAIT_MEAN_EMA_ALPHA * ( newVal - seed )

      // Recency: a significant move this eval (re)stamps the direction; otherwise carry the
      // prior stamp until it ages past the window, then clear it.
      const delta = newVal - oldVal
      let shiftDir  = prev?.shiftDir  ?? 0
      let shiftTick = prev?.shiftTick ?? evalTick
      if( Math.abs( delta ) >= TRAIT_SHIFT_SIGNIFICANCE ){
        shiftDir  = Math.sign( delta )
        shiftTick = evalTick
      }
      else if( shiftDir !== 0 && evalTick - shiftTick > TRAIT_RECENCY_WINDOW ){
        shiftDir = 0
      }

      stats[ key ] = { mean, shiftDir, shiftTick }
    }

    return stats
  }

  protected async reasonAsync(
    footprint: ReasoningFootprint,
    state: ReadonlySimulationState,
    context: SimulationContext,
    stream: IntermediateStream
  ): Promise<unknown> {
    // 1. Compute domain success rates
    const domainAssessments = this._computeDomainAssessments()

    stream.report('domains_evaluated', {
      domainCount: domainAssessments.length,
    })

    // 2. Gather self-beliefs from state entities
    const selfBeliefs = [ ...state.entities.values() ]
      .filter( e => e.type === 'belief'
        && (e.metadata?.['category'] as string | undefined) === 'self_belief'
        && ((e.metadata?.['confidence'] as number | undefined) ?? 0) >= 0.3
      )
      .map( e => ({
        id:                 e.id,
        statement:          ( e.metadata?.['statement']          as string   ) ?? '',
        category:           'self_belief' as const,
        confidence:         ( e.metadata?.['confidence']         as number   ) ?? 0.5,
        supportingEpisodes: ( e.metadata?.['supportingEpisodes'] as number   ) ?? 0,
        lastUpdatedAt:      0,
        tags:               ( e.metadata?.['tags']               as string[] ) ?? [],
      }))

    // 3. Extract current identity from state
    const currentIdentity = this._extractIdentity( state )

    // 4. Generate updated identity
    const updatedIdentity = this._evaluateSelf(
      currentIdentity,
      domainAssessments,
      selfBeliefs
    )

    const changeMagnitude = this._identityChangeMagnitude( currentIdentity, updatedIdentity )

    // Per-trait self-knowledge (baseline + recency) for graded salience B/C. Read the
    // prior stats off identity-self and roll them forward at this evaluation's sim-tick.
    const prevTraitStats = ( state.entities.get('identity-self')?.metadata?.traitStats ?? {} ) as Record<string, TraitStat>
    const traitStats = this._computeTraitStats(
      currentIdentity.traits, updatedIdentity.traits, prevTraitStats, footprint.tickObserved as unknown as number
    )

    stream.report('identity_updated', {
      traitChanges: this._diffTraits( currentIdentity.traits, updatedIdentity.traits ),
      newValues: updatedIdentity.values.filter( v => !currentIdentity.values.includes( v ) )
    })

    return { updatedIdentity, domainAssessments, changeMagnitude, traitStats }
  }

  protected override onIntermediateResult(
    step: string,
    result: unknown,
    _footprint: ReasoningFootprint,
    _context: SimulationContext
  ): StateCommands | null {
    const data = result as Record<string, unknown>

    if( step === 'domains_evaluated')
      return {
        metrics: [
          [ 'self_model.phase', 0 ],
          [ 'self_model.domains', ( data.domainCount as number ) ?? 0 ]
        ]
      }

    if( step === 'identity_updated')
      return {
        metrics: [
          [ 'self_model.phase', 1 ]
        ]
      }

    return null
  }

  protected onReasoningComplete(
    output: unknown,
    footprint: ReasoningFootprint,
    context: SimulationContext
  ): StateCommands {
    const { updatedIdentity, domainAssessments, changeMagnitude, traitStats } = output as {
      updatedIdentity: Keidentity
      domainAssessments: Array<{ domain: string; successRate: number; sampleSize: number }>
      changeMagnitude: number
      traitStats: Record<string, TraitStat>
    }

    // Sim tick of this evaluation (footprint.tickObserved), not wall-clock. It
    // gates re-evaluation via `tick - _lastEvaluationTick >= minIntervalTicks`
    // (shouldAct), so it must be a deterministic tick to replay identically (R2).
    this._lastEvaluationTick = footprint.tickObserved
    this._experienceCountAtLastEval = this._cachedEpisodicTotal

    const commands: StateCommands = {
      set: [{
        id: 'identity-self',
        type: 'will.identity',
        metadata: {
          prompt: updatedIdentity.prompt,
          values: updatedIdentity.values,
          traits: updatedIdentity.traits,
          traitStats,                                  // per-trait baseline + recency (B/C)
          style: updatedIdentity.style,
          version: ( updatedIdentity.version ?? 1 ) + 1
        }
      }],
      metrics: []
    }

    // Domain-specific success rates as metrics
    for( const da of domainAssessments )
      commands.metrics!.push(
        [ `self_model.${da.domain}.success_rate`, da.successRate ],
        [ `self_model.${da.domain}.sample_size`, da.sampleSize ]
      )

    commands.metrics!.push([ 'self_model.version', ( updatedIdentity.version ?? 1 ) + 1 ])

    // Push domain competence beliefs to SemanticIntegrator.
    // Self-model traits are a numeric signal; these natural-language beliefs
    // are what actually surface in the executive's reasoning context.
    // Only domains with ≥5 samples and a clear directional signal produce beliefs.
    if( this._semanticIntegrator ){
      const tick = footprint.tickObserved
      for( const da of domainAssessments ){
        if( da.sampleSize < 5 ) continue
        const confidence = Math.min( 0.82, ( da.sampleSize / ( da.sampleSize + 10 ) ) * 0.9 )

        if( da.successRate > 0.70 )
          this._semanticIntegrator.integrateExecutiveBelief({
            id:                 `belief-competence-${da.domain}-positive`,
            statement:          `I am effective at ${da.domain} tasks`,
            category:           'self_belief',
            confidence,
            supportingEpisodes: da.sampleSize,
            lastUpdatedAt:      tick,
            tags:               [ da.domain, 'competence', 'self', 'positive' ]
          }, tick, 'self-model' )
        
        else if( da.successRate < 0.30 )
          this._semanticIntegrator.integrateExecutiveBelief({
            id:                 `belief-competence-${da.domain}-negative`,
            statement:          `I often struggle with ${da.domain} tasks`,
            category:           'self_belief',
            confidence,
            supportingEpisodes: da.sampleSize,
            lastUpdatedAt:      tick,
            tags:               [ da.domain, 'competence', 'self', 'negative' ]
          }, tick, 'self-model' )
      }
    }

    // Phase C + F: publish cognitive event — gated by prediction error
    const _bus = this._bus
    if( _bus ){
      const predErr = this._model.observe( 'self_model.change', changeMagnitude )
      if( !predErr.gated )
        _bus.publish({ 
          type: 'self_model.updated',
          version: 1,
          sourceEngine: this.name,
          salience: Math.max( 0.4, predErr.salience ),
          payload: { 
            version: ( updatedIdentity.version ?? 1 ) + 1,
            changeMagnitude
          }
        })
    }

    return commands
  }

  // ── Self-evaluation ──────────────────────────────────────

  private _computeDomainAssessments(): Array<{
    domain: string
    successRate: number
    sampleSize: number
  }> {
    const assessments: Array<{ domain: string; successRate: number; sampleSize: number }> = []

    for( const [ domain, records ] of this._domainPerformance ){
      if( records.length < 3 ) continue

      const successCount = records.filter( r => r.success ).length
      assessments.push({
        domain,
        successRate: successCount / records.length,
        sampleSize: records.length,
      })
    }

    // Self-observed emotional stability — formed from affect dynamics, not a task
    // success rate. Confidence ramps with how much affect has been sampled (capped),
    // so a fresh Will's neutral 0.5 barely moves the trait until evidence accumulates.
    if( this._affectObservations > 0 )
      assessments.push({
        domain:      'emotional-regulation',
        successRate: this._affectStabilityEma,
        sampleSize:  Math.min( 20, this._affectObservations ),
      })

    assessments.sort( ( a, b ) => b.sampleSize - a.sampleSize )
    return assessments
  }

  private _extractIdentity( state: ReadonlySimulationState ): Keidentity {
    for( const entity of state.entities.values() )
      if( entity.type === 'will.identity')
        return {
          prompt: ( entity.metadata?.prompt as string )  ?? '',
          values: ( entity.metadata?.values as string[] ) ?? [],
          traits: ( entity.metadata?.traits as Record<string, number> ) ?? {},
          style: ( entity.metadata?.style as string )   ?? '',
          version: ( entity.metadata?.version as number )  ?? 1
        }

    return { prompt: '', values: [], traits: {}, style: '', version: 1 }
  }

  /**
   * Evaluate self based on performance data and existing beliefs.
   * Adjusts trait estimates and updates values.
   */
  private _evaluateSelf(
    current: Keidentity,
    assessments: Array<{ domain: string; successRate: number; sampleSize: number }>,
    beliefs: Belief[]
  ): Keidentity {
    const updated = {
      ...current,
      traits: { ...current.traits },
      values: [ ...current.values ]
    }

    // Update traits based on performance
    for( const assessment of assessments ){
      const traitKey = this._domainToTrait( assessment.domain )
      if( !traitKey ) continue

      const currentTrait = updated.traits[ traitKey ] ?? 0.5
      const confidence = Math.min( 1, assessment.sampleSize / 20 )

      // Exponential moving average — weight by sample confidence
      updated.traits[ traitKey ] = currentTrait * ( 1 - confidence * 0.3 )
                                 + assessment.successRate * confidence * 0.3
    }

    // Integrate self-beliefs into trait updates
    for( const belief of beliefs ){
      if( belief.category !== 'self_belief') continue

      // A positive self-belief nudges only the trait(s) it is actually about (keyword
      // cue) — not every trait. Self-concept still shapes traits, without inflating
      // unrelated dispositions the persona-prior would then develop.
      const text = belief.statement.toLowerCase()
      const isPositive = !text.includes('not') && !text.includes('bad') && !text.includes('poor')
      if( !isPositive ) continue

      for( const trait of traitsCuedBySelfBelief( belief.statement ) )
        updated.traits[ trait ] = Math.min( 1, ( updated.traits[ trait ] ?? 0.5 ) + belief.confidence * 0.02 )
    }

    // Adopt new values if consistently successful in related domains
    if( assessments.some( a => a.domain === 'helping' && a.successRate > 0.7 ) ){
      if( !updated.values.includes('compassion') )
        updated.values.push('compassion')
    }

    if( assessments.some( a => a.domain === 'learning' && a.successRate > 0.6 ) ){
      if( !updated.values.includes('growth') )
        updated.values.push('growth')
    }

    return updated
  }

  private _domainToTrait( domain: string ): string | null {
    const mapping: Record<string, string> = {
      'planning':     'conscientiousness',
      'deciding':     'decisiveness',
      'exploring':    'openness',
      'social':       'agreeableness',
      'helping':      'agreeableness',
      'learning':     'openness',
      'persisting':   'persistence',
      'coping':       'resilience',
      'creating':     'creativity',
      'analyzing':    'analytical',
      'emotional-regulation': 'emotional-stability',
    }

    return mapping[ domain ] ?? null
  }

  private _diffTraits(
    oldTraits: Record<string, number>,
    newTraits: Record<string, number>
  ): string[] {
    const changes: string[] = []

    for( const key of new Set([ ...Object.keys( oldTraits ), ...Object.keys( newTraits ) ]) ){
      const oldVal = oldTraits[ key ] ?? 0.5
      const newVal = newTraits[ key ] ?? 0.5

      if( Math.abs( newVal - oldVal ) > 0.05 )
        changes.push(`${key}: ${oldVal.toFixed( 2 )} → ${newVal.toFixed( 2 )}`)
    }

    return changes
  }

  /**
   * Scalar magnitude of how much the identity actually moved this evaluation —
   * summed absolute trait deltas plus a per-new-value increment. This is the
   * surprise signal the generative model gates on (a real self-revision is a
   * large change), replacing the monotonically-incrementing version counter
   * which always looked like the same "+1" of error.
   */
  private _identityChangeMagnitude( oldId: Keidentity, newId: Keidentity ): number {
    let mag = 0
    for( const key of new Set([ ...Object.keys( oldId.traits ), ...Object.keys( newId.traits ) ]) )
      mag += Math.abs( ( newId.traits[ key ] ?? 0.5 ) - ( oldId.traits[ key ] ?? 0.5 ) )

    mag += newId.values.filter( v => !oldId.values.includes( v ) ).length * 0.1

    return mag
  }
}
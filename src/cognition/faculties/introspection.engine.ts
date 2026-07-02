// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/introspection.engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * IntrospectionEngine — satellite mode.
 * 
 * Reads the most recent ExecutiveEngine output for introspections.
 * Performs heuristic self-analysis between executive runs for minor events.
 * No longer makes its own LLM calls.
 */

import type {
  Duration, Tick, SimulationContext,
  ReadonlySimulationState, StateCommands, SimulationEvent,
} from '#core/types'
// import type { ExecutiveEngine } from '#faculties/executive.engine'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'
import { ExecutiveEngine } from './executive.engine'

export interface IntrospectionEngineConfig {
  cooldownTicks?: number
  significanceThreshold?: number
  bus?: CognitiveBus
}

export interface IntrospectionResult {
  question: string
  explanation: string
  identifiedBiases: string[]
  lessons: string[]
  introspectedAt: Tick
  analyzedTicks: Tick[]
}

export class IntrospectionEngine implements SimulationEngine, CognitiveEngine {
  readonly name     = 'introspection-engine'
  
  private _cooldownTicks: number
  private _significanceThreshold: number

  private _lastIntrospectionTick: number = -100
  private _introspectionHistory: IntrospectionResult[] = []
  private _emittedEntityIds: string[] = []
  private _executiveEngine: ExecutiveEngine | null = null

  private _affectArousal: number = 0.3

  private _bus: CognitiveBus | null = null

  private readonly _model = new GenerativeModel()


  constructor( config: IntrospectionEngineConfig = {} ){
    this._bus = config.bus ?? null
    this._cooldownTicks         = config.cooldownTicks         ?? 50
    this._significanceThreshold = config.significanceThreshold ?? 0.4
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  attachExecutiveEngine( oe: ExecutiveEngine ): void {
    this._executiveEngine = oe
  }

  subscribes(): string[] { return ["affect.state.changed","executive.prediction.formed"] }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    switch( e.type ){
      case 'affect.state.changed':
        this._affectArousal = (e.payload as Record<string,number>)['arousal'] ?? this._affectArousal
        break
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if (p.predictedDomains.includes('metacognition'))
          this._model.setPrecision('introspection.significance', 1.0 + p.confidence * 0.5)
        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      affectArousal: this._affectArousal,
    }
  }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    const events: Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = []
    const commands: StateCommands = { set: [], metrics: [] }

    // Effective config = base ⊕ persona-prior. Closes the bias → introspection
    // edge: when the consolidator lowers cooldownTicks (recurring bias), the Will
    // introspects more often.
    this._readConfigFromState( state )

    // Did this tick actually produce an introspection, and how substantive was
    // it? This is the surprise signal — replaces the every-tick publish gated on
    // a monotonic history count (which never read as surprising once it grew).
    let introspectedThisTick = false
    let significance = 0

    // Try executive output first
    const executiveOutput = this._executiveEngine?.latestOutput

    if( executiveOutput?.introspection && this._executiveEngine?.isFresh( tick ) ){
      const result: IntrospectionResult = {
        question: 'Executive introspection',
        explanation: executiveOutput.introspection.explanation,
        identifiedBiases: executiveOutput.introspection.identifiedBiases,
        lessons: executiveOutput.introspection.lessonsLearned,
        introspectedAt: tick,
        analyzedTicks: [ tick ],
      }

      this._introspectionHistory.push( result )
      if( this._introspectionHistory.length > 50 )
        this._introspectionHistory = this._introspectionHistory.slice( -30 )

      const entityId = `introspection-executive-${tick}`
      this._emittedEntityIds.push( entityId )
      commands.set!.push({
        id: entityId,
        type:     'introspection',
        metadata: {
          question: result.question,
          explanation: result.explanation,
          identifiedBiases: result.identifiedBiases,
          lessons: result.lessons,
          source: 'executive',
        },
      })

      introspectedThisTick = true
      significance = result.identifiedBiases.length + result.lessons.length
      commands.metrics!.push([ 'introspection.source', 1 ])
    }
    else if( this._shouldHeuristicIntrospect( state, tick ) ){
      const result = this._heuristicIntrospection( state, tick )

      this._introspectionHistory.push( result )
      if( this._introspectionHistory.length > 50 )
        this._introspectionHistory = this._introspectionHistory.slice( -30 )

      const entityId = `introspection-heuristic-${tick}`
      this._emittedEntityIds.push( entityId )
      commands.set!.push({
        id: entityId,
        type:     'introspection',
        metadata: {
          question: result.question,
          explanation: result.explanation,
          identifiedBiases: result.identifiedBiases,
          lessons: result.lessons,
          source: 'heuristic',
        },
      })

      introspectedThisTick = true
      significance = result.identifiedBiases.length + result.lessons.length
      commands.metrics!.push([ 'introspection.source', 0 ])
    }

    // Prune old entities
    if( this._emittedEntityIds.length > 10 ){
      commands.delete = this._emittedEntityIds.splice( 0, this._emittedEntityIds.length - 10 )
    }

    commands.metrics!.push([ 'introspection.total', this._introspectionHistory.length ])

    // Phase C: publish a cognitive event only when this tick actually
    // introspected. Salience rides the `introspection.significance` stream —
    // the same stream the executive's precision knob targets (they were
    // mismatched: precision set on .significance, salience read off .total).
    const _bus = this._bus
    if( _bus && introspectedThisTick )
      _bus.publish({ type: 'introspection.insight', version: 1, sourceEngine: this.name, salience: Math.max( 0.3, this._model.observe( 'introspection.significance', significance ).salience ), payload: { total: this._introspectionHistory.length, significance } })
    return { events: events.length > 0 ? events : undefined, commands }
  }

  private _shouldHeuristicIntrospect( state: ReadonlySimulationState, tick: Tick ): boolean {
    if( tick - this._lastIntrospectionTick < this._cooldownTicks ) return false
    const significance = state.metrics.get('outcome.significance') ?? 0
    return significance > this._significanceThreshold
  }

  private _heuristicIntrospection( state: ReadonlySimulationState, tick: Tick ): IntrospectionResult {
    // Reflect on biases ALREADY detected by bias.detector (the single detection authority)
    // rather than re-detecting them here — introspection turns them into lessons. (High
    // arousal is an in-the-moment reflection on emotional influence, not a stored bias, so
    // that observation stays.)
    const detectedBiases: string[] = []
    for( const entity of state.entities.values() )
      if( entity.type === 'cognitive_bias' )
        detectedBiases.push(
          ( entity.metadata?.description as string )
          ?? ( entity.metadata?.type as string )
          ?? 'a cognitive bias'
        )

    const lessons: string[] = []
    if( detectedBiases.length > 0 )
      lessons.push('Be aware of these biases when making high-confidence decisions')

    const arousal = this._affectArousal
    if( arousal > 0.6 )
      lessons.push('Consider pausing deliberation when highly aroused')

    this._lastIntrospectionTick = tick

    return {
      question: 'What patterns are present in my recent reasoning?',
      explanation: `Reflected on ${detectedBiases.length} bias(es) detected this period.`,
      identifiedBiases: detectedBiases,
      lessons,
      introspectedAt: tick,
      analyzedTicks: [],
    }
  }

  /**
   * Effective config = base engine-config ⊕ persona-prior. The consolidator
   * lowers `cooldownTicks` when bias is recurring, so introspection runs more
   * often. (The seeded base matches this engine's defaults — no single-source
   * drift — so reading base⊕prior is safe here.)
   */
  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const p = readEffectiveParams( state, 'engine-config-introspection' )
    if( p.cooldownTicks != null )         this._cooldownTicks         = p.cooldownTicks
    if( p.significanceThreshold != null ) this._significanceThreshold = p.significanceThreshold
  }

  getHistory(): ReadonlyArray<IntrospectionResult> {
    return this._introspectionHistory
  }
}
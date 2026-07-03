// ─────────────────────────────────────────────────────────────
// src/cognition/orchestrator.ts
// ─────────────────────────────────────────────────────────────

/**
 * CognitiveOrchestrator — extends DefaultOrchestrator with the three concerns
 * that belong to the cognitive layer:
 *
 *   1. Bus wiring — subscribe engines to the bus on addEngine; call attachBus()
 *      so engines hold a direct reference for publishing (Phase F constructor injection).
 *   2. Cold-start snapshot — broadcast engine states before the first tick.
 *   3. HeartbeatPublisher — registered as onAfterTick middleware; owns bus flush
 *      + clock.tick delivery.
 *
 * Context enrichment (cognitiveBus in SimulationContext) has been removed:
 * engines now hold the bus directly via constructor injection or attachBus().
 */

import type { SimulationContext, Tick, ReadonlySimulationState } from '#core/types'
import type { SimulationEngine, OrchestratorConfig } from '#core/orchestrator'
import type { SimulationClock } from '#core/clock'
import type { EventBus } from '#core/event.bus'
import type { StateManager } from '#core/state.manager'
import type { CognitiveBus } from '#cognition/bus'
import { DefaultOrchestrator } from '#core/orchestrator'
import { createProductionBus } from '#cognition/bus'
import { CompletionInbox } from '#cognition/completion.inbox'
import { isCognitiveEngine } from '#cognition/types'
import { HeartbeatPublisher } from '#cognition/heartbeat'

export interface CognitiveOrchestratorConfig extends OrchestratorConfig {
  /**
   * The shared CognitiveBus instance.
   * When omitted, CognitiveOrchestrator creates a production bus internally.
   * Pass an explicit bus only when you need a shared or test bus.
   */
  cognitiveBus?: CognitiveBus
}

export class CognitiveOrchestrator extends DefaultOrchestrator {
  private readonly _bus: CognitiveBus
  private readonly _heartbeat: HeartbeatPublisher
  private readonly _inbox: CompletionInbox

  constructor(
    clock:        SimulationClock,
    eventBus:     EventBus,
    stateManager: StateManager,
    config:       CognitiveOrchestratorConfig
  ){
    super( clock, eventBus, stateManager, config )

    this._bus       = config.cognitiveBus ?? createProductionBus()
    this._heartbeat = new HeartbeatPublisher( this._bus )
    this._inbox     = new CompletionInbox()
  }

  /** The tick-boundary landing queue for async completion effects. */
  get completionInbox(): CompletionInbox { return this._inbox }

  // ── Phase 2 hook ─────────────────────────────────────────────

  protected override async _onAfterPhase1(
    tick:    Tick,
    state:   ReadonlySimulationState,
    _ctx:    SimulationContext
  ): Promise<void> {
    // Pass 0: land async completion effects (facet decisions staged at LLM-
    // promise resolution). FIRST — so listener effects (plan mutations, outbox
    // writes) and any bus events those listeners publish deliver in THIS phase,
    // keeping each decision's landing atomic at one tick boundary.
    this._inbox.drain( tick )

    // Pass 1: deliver events engines queued during react()
    this._bus.flush()

    // Publish clock.tick (adaptive — may be a no-op during quiet periods)
    this._heartbeat.publishTick( tick, state )

    // Pass 2: deliver clock.tick to subscribers
    this._bus.flush()

    // Phase 2 commit: apply all StateCommands returned by onCognitiveEvent() handlers
    for( const commands of this._bus.drainCommands() )
      this._stateManager.applyCommands( commands )
  }

  protected override _enginesTick(): SimulationEngine[] {
    return this._engines.filter( e => e.react !== undefined )
  }

  // ── Engine wiring ────────────────────────────────────────────

  override addEngine( engine: SimulationEngine ): void {
    super.addEngine( engine )

    // Phase F: give the engine a direct bus reference for publishing
    if( 'attachBus' in engine && typeof ( engine as any ).attachBus === 'function' ){
      ( engine as any ).attachBus( this._bus )
    }

    // Tick-boundary landing: engines that stage async completion effects
    // (the ExecutiveEngine, for its facets) receive the shared inbox.
    if( 'attachCompletionInbox' in engine && typeof ( engine as any ).attachCompletionInbox === 'function' ){
      ( engine as any ).attachCompletionInbox( this._inbox )
    }

    // Wire delivery: subscribe the engine to its declared topics
    if( isCognitiveEngine( engine ) ){
      const topics = engine.subscribes()
      if( topics.length > 0 ){
        const acceptsFn = engine.acceptsVersions?.bind( engine )
        this._bus.subscribe( engine.name, topics, ev => engine.onCognitiveEvent( ev ), acceptsFn )
      }
    }
  }

  override removeEngine( name: string ): boolean {
    const removed = super.removeEngine( name )
    if( removed ) this._bus.unsubscribe( name )

    return removed
  }

  // ── Cold-start snapshot ──────────────────────────────────────

  override async start( context: SimulationContext ): Promise<void> {
    for( const engine of this._engines )
      if( isCognitiveEngine( engine ) )
        this._bus.publish({
          type: 'engine.snapshot',
          version: 1,
          sourceEngine: engine.name,
          salience: 0,
          payload: engine.snapshot()
        })
    
    this._bus.flush()

    await super.start( context )
  }
}

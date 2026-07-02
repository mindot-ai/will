// ─────────────────────────────────────────────────────────────
// src/cognition/heartbeat.ts
// ─────────────────────────────────────────────────────────────

/**
 * HeartbeatPublisher — demotes the tick from execution gate to clock signal.
 *
 * Plugs into the orchestrator's onAfterTick middleware. After every tick
 * completes, it publishes a 'clock.tick' event to the CognitiveBus and
 * calls bus.flush() so queued deliveries are dispatched synchronously.
 *
 * Engines that need time-based behavior (decay, deadlines, cooldowns)
 * subscribe to 'clock.tick'. Engines that are purely event-driven ignore it.
 *
 * Adaptive interval support: the publisher tracks quiet vs active periods
 * and the bus consumer can inspect the 'clock.tick' payload's `intervalHint`
 * to decide whether to act this tick.
 */

import type { Tick, ReadonlySimulationState } from '#core/types'
import type { CognitiveBus } from '#cognition/bus'
// Ensure SimulationContext augmentation (cognitiveBus?) is in scope
import '#cognition/bus'

const CLOCK_TICK_VERSION = 1

// When quiet, emit clock.tick only every N ticks (reduces bus traffic)
const QUIET_TICK_INTERVAL = 5

export class HeartbeatPublisher {
  private _bus: CognitiveBus
  private _sourceName = 'heartbeat-publisher'
  private _quietTicks = 0

  constructor( bus: CognitiveBus ){
    this._bus = bus
  }

  /**
   * Called directly from CognitiveOrchestrator._onAfterPhase1() after the
   * EventBus flush. Publishes clock.tick to the CognitiveBus with adaptive
   * quiet-period throttling.
   */
  publishTick( tick: Tick, state: ReadonlySimulationState ): void {
    const
    activeAgents = state.metrics.get('social.active_agents') ?? 0,
    stressZone   = state.metrics.get('stress.zone') ?? 1,
    isActive     = activeAgents > 0 || stressZone >= 2

    if( isActive ){
      this._quietTicks = 0
    } else {
      this._quietTicks++
      if( this._quietTicks % QUIET_TICK_INTERVAL !== 0 ) return
    }

    this._bus.publish({
      type: 'clock.tick',
      version: CLOCK_TICK_VERSION,
      sourceEngine: this._sourceName,
      salience: 0,
      payload: {
        tick,
        delta: state.metrics.get('system.last_delta') ?? 50,
        isActive,
        intervalHint: isActive ? 1 : Math.min( this._quietTicks, QUIET_TICK_INTERVAL ),
      }
    })
  }
}

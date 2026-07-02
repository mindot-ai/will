// ─────────────────────────────────────────────────────────────
// src/core/metrics.ts
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type { ReadonlySimulationState, SimulationContext, Tick, Timestamp } from '#core/types'

export interface MetricCollector {
  record( name: string, value: number, tags?: Record<string, string> ): void
  increment( name: string, delta?: number, tags?: Record<string, string> ): void
  gauge( name: string, value: number, tags?: Record<string, string> ): void
  histogram( name: string, value: number, tags?: Record<string, string> ): void
  flush(): Promise<void>
}

/**
 * MetricCollector directly implements TickMiddleware.
 * The onTick method serves as the orchestrator's onAfterTick hook.
 */
export interface MetricPoint {
  name: string
  value: number
  tags: Record<string, string>
  timestamp: Timestamp
  tick: Tick
  type: 'counter' | 'gauge' | 'histogram'
}

export class DefaultMetricCollector implements MetricCollector {
  private _points: MetricPoint[] = []
  private _flushInterval: NodeJS.Timeout | null = null
  private _flushCallback: ( ( points: MetricPoint[] ) => Promise<void> ) | null = null
  private _currentTick: Tick = 0
  private _currentTime: Timestamp = 0

  constructor( autoFlushMs: number = 5000, flushCallback?: ( points: MetricPoint[] ) => Promise<void> ){
    flushCallback && ( this._flushCallback = flushCallback )
    autoFlushMs > 0 && ( this._flushInterval = setInterval( () => { this.flush().catch( () => {} ) }, autoFlushMs ) )
  }

  /**
   * Implements the TickMiddleware signature.
   * Wire this as orchestratorConfig.onAfterTick to capture metrics.
   */
  onTick = ( tick: Tick, _state: ReadonlySimulationState, _context: SimulationContext ): void => {
    this._currentTick = tick
    this._currentTime = _state.time
  }

  record( name: string, value: number, tags: Record<string, string> = {} ): void {
    this._points.push({
      name,
      value,
      tags,
      timestamp: this._currentTime,
      tick:      this._currentTick,
      type:      'counter',
    })
  }

  increment( name: string, delta: number = 1, tags: Record<string, string> = {} ): void {
    this.record( name, delta, tags )
  }

  gauge( name: string, value: number, tags: Record<string, string> = {} ): void {
    this._points.push({
      name,
      value,
      tags,
      timestamp: this._currentTime,
      tick:      this._currentTick,
      type:      'gauge',
    })
  }

  histogram( name: string, value: number, tags: Record<string, string> = {} ): void {
    this._points.push({
      name,
      value,
      tags,
      timestamp: this._currentTime,
      tick:      this._currentTick,
      type:      'histogram',
    })
  }

  async flush(): Promise<void> {
    if( this._points.length === 0 ) return

    const points = this._points.splice( 0 )
    if( this._flushCallback )
      await this._flushCallback( points )

    else {
      logger.info(`[Metrics] Flushed ${points.length} points`)
      for( const point of points.slice( 0, 10 ) )
        logger.info(`  ${point.type}: ${point.name}=${point.value} @ tick ${point.tick}`)

      points.length > 10 && logger.info(`  ... and ${points.length - 10} more`)
    }
  }

  destroy(): void {
    this._flushInterval && clearInterval( this._flushInterval )
    this._flushInterval = null
  }
}
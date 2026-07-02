// ─────────────────────────────────────────────────────────────
// src/core/clock.ts
// ─────────────────────────────────────────────────────────────

/**
 * Core simulation clock — completely generic.
 * No time-of-day, calendar, or domain-specific logic.
 * Time is just milliseconds since epoch.
 */

import type { Duration, Tick, Timestamp } from '#core/types'
import { wallClock } from '#core/wall.clock'

export interface SimulationClock {
  readonly now: Timestamp
  readonly currentTick: Tick
  readonly delta: Duration
  readonly isRunning: boolean
  readonly multiplier: number

  // Driven externally by the Orchestrator
  tick(): void

  // Lifecycle
  pause(): void
  resume(): void
  reset(): void

  // Time manipulation
  setTime( time: Timestamp ): void
  setTick( tick: Tick ): void
  setMultiplier( newMultiplier: number ): void

  // Helpers
  toSimMs( wallMs: number ): number
  toWallMs( simMs: number ): number
  simSleep( simMs: number ): Promise<void>
}

export interface ClockConfig {
  startTime?: Timestamp
  startTick?: Tick
  timeScale?: number  // 1.0 = real-time, 2.0 = 2× real-time
  /** When set, tick() uses this fixed duration (ms) instead of wall time. */
  fixedDeltaMs?: number
}

export class DefaultSimulationClock implements SimulationClock {
  private _now: Timestamp
  private _tick: Tick
  private _delta: Duration = 0
  private _lastTick: Timestamp
  private _isRunning = true
  private _timeScale: number
  private _pausedAt: Timestamp | null = null
  private _fixedDeltaMs: number | null = null

  // Anchors for accurate now() under dynamic multiplier
  private _startWallMs: Timestamp
  private _startSimMs: Timestamp

  constructor( config: ClockConfig = {} ){
    this._now = config.startTime ?? wallClock()
    this._tick = config.startTick ?? 0
    this._lastTick = this._now
    this._timeScale = config.timeScale ?? 1.0
    this._fixedDeltaMs = config.fixedDeltaMs ?? null

    this._startWallMs = wallClock()
    this._startSimMs = this._now
  }

  // ── Getters ─────────────────────────────────────────────

  get now(): Timestamp {
    // Deterministic mode: time only advances inside tick(); never read wall
    // time, so SimulationState.time reproduces exactly on replay (R2).
    if( this._fixedDeltaMs !== null ) return this._now

    if( !this._isRunning ) return this._now

    const wallElapsed = wallClock() - this._startWallMs
    return this._startSimMs + wallElapsed * this._timeScale
  }

  get currentTick(): Tick { return this._tick }
  get delta(): Duration   { return this._delta }
  get isRunning(): boolean { return this._isRunning }
  get multiplier(): number { return this._timeScale }

  // ── Core tick ───────────────────────────────────────────

  /**
   * The Orchestrator calls this once per tick as the single 
   * source of tick advancement.
   */
  tick(): void {
    if( !this._isRunning ) return

    // Deterministic mode: advance by a fixed sim delta, never reading wall
    // time. This is what makes the tick→time mapping reproducible on replay (R2).
    if( this._fixedDeltaMs !== null ){
      this._delta = this._fixedDeltaMs * this._timeScale
      this._now  += this._delta
      this._tick += 1
      return
    }

    const
    realNow     = wallClock(),
    realDelta   = realNow - this._lastTick,
    scaledDelta = realDelta * this._timeScale

    this._delta    = scaledDelta
    this._now      = this.now
    this._tick    += 1
    this._lastTick = realNow
  }

  // ── Lifecycle ───────────────────────────────────────────

  pause(): void {
    if( !this._isRunning ) return

    this._isRunning = false
    this._pausedAt  = wallClock()
  }

  resume(): void {
    if( this._isRunning ) return

    this._isRunning = true

    if( this._pausedAt !== null ){
      const pauseDuration = wallClock() - this._pausedAt

      // Shift anchors to compensate for pause — maintains continuous time
      this._startWallMs += pauseDuration
      this._lastTick     = wallClock() - ( this._pausedAt - this._lastTick )
      this._pausedAt     = null
    }
  }

  reset(): void {
    const now = wallClock()

    this._now         = now
    this._tick        = 0
    this._delta       = 0
    this._lastTick    = now
    this._isRunning   = true
    this._pausedAt    = null
    this._startWallMs = now
    this._startSimMs  = now
  }

  // ── Time manipulation ───────────────────────────────────

  setTime( time: Timestamp ): void {
    this._now          = time
    this._startSimMs   = time
    this._startWallMs  = wallClock()
    this._lastTick     = this._startWallMs
  }

  setTick( tick: Tick ): void {
    this._tick = tick
  }

  setMultiplier( newMultiplier: number ): void {
    if( newMultiplier <= 0 )
      throw new Error('Multiplier must be positive')

    // Re-anchor current sim time to prevent jumps
    const simNow = this.now

    this._startSimMs   = simNow
    this._startWallMs  = wallClock()
    this._timeScale    = newMultiplier
  }

  // ── Helpers ─────────────────────────────────────────────

  toSimMs( wallMs: number ): number {
    return wallMs * this._timeScale
  }

  toWallMs( simMs: number ): number {
    return simMs / this._timeScale
  }

  async simSleep( simMs: number ): Promise<void> {
    const wallMs = this.toWallMs( simMs )
    return new Promise( resolve => setTimeout( resolve, wallMs ) )
  }
}
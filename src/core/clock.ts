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

  /**
   * Hear every step the clock takes, after it is taken. One listener; `null`
   * removes it. The record chain uses this to chain each step at the moment it
   * begins (RECORD_ANCHORING step 4).
   */
  onStep( listener: ClockStepListener | null ): void
  /**
   * Take each step from here instead of measuring one: a replay feeds the
   * steps a live run chained. `null` returns the clock to its own time.
   */
  setStepSource( source: ClockStepSource | null ): void

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

/** One step of the clock: the sim time it reached and how far it moved. */
export interface ClockStep {
  readonly now:   Timestamp
  readonly delta: Duration
}
export type ClockStepListener = ( step: ClockStep, tick: Tick ) => void
export type ClockStepSource   = () => ClockStep

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

  private _onStep:     ClockStepListener | null = null
  private _stepSource: ClockStepSource   | null = null

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

  /**
   * The sim time of the current tick. It moves only when the clock steps, in
   * either mode: between ticks it holds still. Read continuously, a wall-mode
   * clock handed whatever ran between ticks — an LLM answer landing, a sense
   * turn — a time no record carried, so no replay could hand it back
   * (RECORD_ANCHORING step 4). Fixed mode always held still (R2).
   */
  get now(): Timestamp { return this._now }

  /** Where wall time has carried sim time to, read now. Wall mode only. */
  private _wallNow(): Timestamp {
    if( !this._isRunning ) return this._now
    return this._startSimMs + ( wallClock() - this._startWallMs ) * this._timeScale
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

    if( this._stepSource ){
      // Replay: the step a live run took, as it chained it.
      const step = this._stepSource()
      this._delta    = step.delta
      this._now      = step.now
      this._lastTick = wallClock()
    }
    else if( this._fixedDeltaMs !== null ){
      // Deterministic mode: advance by a fixed sim delta, never reading wall
      // time. This is what makes the tick→time mapping reproducible on replay (R2).
      this._delta = this._fixedDeltaMs * this._timeScale
      this._now  += this._delta
    }
    else {
      const realNow = wallClock()
      this._delta    = ( realNow - this._lastTick ) * this._timeScale
      this._now      = this._wallNow()
      this._lastTick = realNow
    }

    this._tick += 1
    this._onStep?.( { now: this._now, delta: this._delta }, this._tick )
  }

  onStep( listener: ClockStepListener | null ): void { this._onStep = listener }
  setStepSource( source: ClockStepSource | null ): void { this._stepSource = source }

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
    const simNow = this._fixedDeltaMs !== null ? this._now : this._wallNow()

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
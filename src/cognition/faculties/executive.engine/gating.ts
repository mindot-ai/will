// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/gating.ts
// ─────────────────────────────────────────────────────────────

import type { PendingMessage } from '#faculties/executive.engine/types'
import type { Tick, ReadonlySimulationState } from '#core/types'
import type { GenerativeModel } from '#cognition/generative.model'
import {
  BUFFER_SALIENCE_TRIGGER,
  BUFFER_MAX_AGE_TICKS,
} from '#faculties/executive.engine/config'
import type { CognitiveEvent } from '#cognition/bus'

function hasPendingInstructions( state: ReadonlySimulationState, pendingMessages: PendingMessage[] ): boolean {
  for( const entity of state.entities.values() ){
    if( entity.type === 'percept' || entity.type === 'percept.social'){
      const salience = (entity.metadata?.salience as number) ?? 0
      if( salience > 0.7 ) return true
    }

    // An unprocessed `communication` entity used to wake the master here. Nothing has
    // ever written that type (#114), and the current design deliberately routes inbound
    // to a facet instead — the master learns of it via `audition.task.signal` → a
    // high-salience percept, which the percept branch above already catches.
  }

  return pendingMessages.length > 0
}

export interface GatingDependencies {
  generativeModel: GenerativeModel
  pendingMessages: PendingMessage[]
  hasPendingWork: boolean
}

export interface SalienceBufferEntry {
  event: CognitiveEvent
  tick: number
}

export interface GatingState {
  executiveInterval: number
  cooldownTicks: number
  lastExecutiveTick: number
  salienceBuffer: SalienceBufferEntry[]
  goallessTickCount: number
  lowValenceTickCount: number
}

export interface GatingResult {
  shouldActivate: boolean
  reason: string
  /** Cleaned buffer with stale entries removed — caller must update GatingState. */
  cleanedBuffer: SalienceBufferEntry[]
}

/**
 * Full gating logic — pure function.
 * Receives all state, returns decision + reason + cleaned buffer.
 * The caller is responsible for updating GatingState with the result.
 */
export function evaluateGating(
  state: ReadonlySimulationState,
  tick: Tick,
  deps: GatingDependencies,
  gs: GatingState,
): GatingResult {
  // ── In-flight work check ──────────────────────────────────
  if( deps.hasPendingWork )
    return {
      shouldActivate: false,
      reason: 'hasPendingWork',
      cleanedBuffer: gs.salienceBuffer
    }

  // ── Cooldown — always enforced ────────────────────────────
  if( tick - gs.lastExecutiveTick < gs.cooldownTicks )
    return {
      shouldActivate: false,
      reason: 'cooldown',
      cleanedBuffer: gs.salienceBuffer
    }

  // ── Read metrics ──────────────────────────────────────────
  const energy        = state.metrics.get('energy.level')       ?? 100
  const isResting     = state.metrics.get('state.resting')      ?? 0
  const isSleeping    = state.metrics.get('state.sleeping')     ?? 0
  const isForcedRest  = state.metrics.get('state.forced_rest')  ?? 0
  const novelty       = state.metrics.get('perception.novelty') ?? 0
  const sleepPressure = state.metrics.get('sleep.pressure')     ?? 0
  const stressLoad    = state.metrics.get('stress.load')        ?? 0
  const valence       = state.metrics.get('affect.valence')     ?? 0

  // ── Drop stale buffer entries ─────────────────────────────
  const cleanedBuffer = gs.salienceBuffer.filter( e => tick - e.tick < BUFFER_MAX_AGE_TICKS )

  // ── Accumulated workspace salience (GWT ignition pressure) ─
  // Computed up-front so it both overrides prediction-gating at the interval
  // boundary and drives the pre-interval early trigger further below.
  const totalSalience   = cleanedBuffer.reduce( ( s, e ) => s + ( e.event.salience ?? 0 ), 0 )
  const salienceCharged = totalSalience >= BUFFER_SALIENCE_TRIGGER

  // ── Forced shutdown (energy < 1) ──────────────────────────
  if( isForcedRest > 0 )
    return {
      shouldActivate: false,
      reason: 'forced_rest',
      cleanedBuffer
    }

  // ── Voluntary rest/sleep — wake on high novelty or pending instructions ─
  if( isResting > 0 || isSleeping > 0 ){
    const
    significantEvent = novelty > 0.8,
    hasPending = hasPendingInstructions( state, deps.pendingMessages )

    if( significantEvent || hasPending )
      return {
        shouldActivate: true,
        reason: `awakened_from_${isSleeping > 0 ? 'sleep' : 'rest'}`,
        cleanedBuffer
      }
    
    return {
      shouldActivate: false,
      reason: 'resting',
      cleanedBuffer
    }
  }

  // ── Count active goals ────────────────────────────────────
  let activeGoalCount = 0
  for( const entity of state.entities.values() )
    if( entity.type === 'goal' && entity.metadata?.status === 'active')
      activeGoalCount++

  // ── Physiological crises — bypass executiveInterval ───────
  if( sleepPressure > 65 )
    return { shouldActivate: true, reason: 'sleep_pressure_critical', cleanedBuffer }
  
  if( stressLoad > 75 )
    return { shouldActivate: true, reason: 'stress_overload', cleanedBuffer }
  
  if( energy < 15 )
    return { shouldActivate: true, reason: 'energy_critical', cleanedBuffer }

  // ── Pending messages — always fire ────────────────────────
  if( deps.pendingMessages.length > 0 )
    return { shouldActivate: true, reason: 'pending_message', cleanedBuffer }

  // ── Normal interval scheduling ────────────────────────────
  if( tick - gs.lastExecutiveTick >= gs.executiveInterval ){
    // Prediction-error gating — uses GenerativeModel.observe() which returns { gated }
    const energyErr  = deps.generativeModel.observe('energy.level', energy)
    const stressErr  = deps.generativeModel.observe('stress.load', stressLoad)
    const noveltyErr = deps.generativeModel.observe('perception.novelty', novelty)
    const valenceErr = deps.generativeModel.observe('affect.valence', valence)

    const allGated = energyErr.gated && stressErr.gated && noveltyErr.gated && valenceErr.gated
    const overdue  = tick - gs.lastExecutiveTick >= gs.executiveInterval * 1.5

    // A salience-charged workspace ignites even when every signal is well-predicted:
    // accumulated salient coalitions are exactly what GWT ignition is meant to catch,
    // so prediction-gating must not suppress them at the interval boundary.
    if( allGated && !overdue && !salienceCharged )
      return { shouldActivate: false, reason: 'prediction_gated', cleanedBuffer }

    return {
      shouldActivate: true,
      reason: salienceCharged ? 'salience_charged' : 'interval_elapsed',
      cleanedBuffer
    }
  }

  // ── Salience competition — early trigger (pre-interval) ───
  if( salienceCharged )
    return { shouldActivate: true, reason: 'salience_charged', cleanedBuffer }

  // ── Cognitive crises — early trigger ──────────────────────
  // Counter values are computed here (the caller will persist them via updateGatingState)
  const goallessTicks  = activeGoalCount === 0 ? gs.goallessTickCount + 1 : 0
  const lowValenceTicks = valence < -0.4 ? gs.lowValenceTickCount + 1 : 0

  if( goallessTicks > 20 )
    return { shouldActivate: true, reason: 'goalless_crisis', cleanedBuffer }
  
  if( lowValenceTicks > 30 )
    return { shouldActivate: true, reason: 'low_valence_crisis', cleanedBuffer }

  // ── High novelty — early trigger ──────────────────────────
  if( novelty > 0.7 )
    return { shouldActivate: true, reason: 'high_novelty', cleanedBuffer }

  return { shouldActivate: false, reason: 'no_trigger', cleanedBuffer }
}

/**
 * Update the persistent gating state after a tick.
 * Called every tick regardless of whether the executive activated.
 */
export function updateGatingState(
  gs: GatingState,
  state: ReadonlySimulationState,
  _tick: Tick,
  didActivate: boolean,
  cleanedBuffer: SalienceBufferEntry[],
): void {
  // Apply cleaned buffer
  gs.salienceBuffer = cleanedBuffer

  // Update crisis counters
  let activeGoalCount = 0
  for( const entity of state.entities.values() )
    if( entity.type === 'goal' && entity.metadata?.status === 'active')
      activeGoalCount++
  
  const valence = state.metrics.get('affect.valence') ?? 0

  gs.goallessTickCount  = activeGoalCount === 0 ? gs.goallessTickCount + 1 : 0
  gs.lowValenceTickCount = valence < -0.4 ? gs.lowValenceTickCount + 1 : 0

  if( didActivate )
    gs.lastExecutiveTick = _tick
}
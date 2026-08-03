// ─────────────────────────────────────────────────────────────
// src/cognition/cache/fingerprint.ts
// ─────────────────────────────────────────────────────────────

/**
 * CognitiveFingerprint — extracts a deterministic scalar vector from the
 * frozen simulation state. No wall-clock, no RNG, no iteration-order
 * dependence (values are sorted before they enter fixed slots). The vector
 * captures the operating context that most strongly conditions executive
 * reasoning — the same scalars the prompt's `## Current State` block renders.
 *
 * Dimension layout (fixed order — never reorder without bumping the version):
 *   0–2   physiology         energy.level, sleep.pressure, stress.load   (metrics, 0–100 → 0–1)
 *   3–5   PAD affect         valence (−1..1 → 0..1), arousal, dominance  (metrics, 0–1)
 *   6–15  goal priorities    top 10 `goal` entities by metadata.priority (0..1)
 *  16–25  belief confidences top 10 `belief` entities by metadata.confidence (0..1)
 *  26–35  wm activations     top 10 `working_memory.item` by metadata.activation (0..1)
 *
 * Total: 36 dimensions. Verified against the live writers:
 *   - interoception.ts writes energy.level / sleep.pressure (0–100)
 *   - stress.regulator.ts writes stress.load
 *   - affective.blender.ts writes affect.valence (−1..1) / arousal / dominance (0..1)
 *   - goal.manager.ts persists goal entities with metadata.priority
 *   - executive.engine/commands.ts + semantic integrator persist belief entities
 *     with metadata.confidence
 *   - working.memory.ts persists working_memory.item entities with metadata.activation
 */

import type { ReadonlySimulationState } from '#core/types'

export const FINGERPRINT_DIM = 36
export const FINGERPRINT_VERSION = 1

export function extractFingerprint( state: ReadonlySimulationState ): Float32Array {
  const vec = new Float32Array( FINGERPRINT_DIM )
  let idx = 0

  // ── Physiology (metrics are 0–100) ───────────────────────
  vec[ idx++ ] = _norm( _metric( state, 'energy.level', 50 ), 0, 100 )
  vec[ idx++ ] = _norm( _metric( state, 'sleep.pressure', 0 ), 0, 100 )
  vec[ idx++ ] = _norm( _metric( state, 'stress.load', 0 ), 0, 100 )

  // ── PAD affect ───────────────────────────────────────────
  // valence is written on [-1, 1]; map to [0, 1] so a distressed state is not
  // silently clamped to neutral. arousal / dominance are already [0, 1].
  vec[ idx++ ] = _clamp01( ( _metric( state, 'affect.valence', 0 ) + 1 ) / 2 )
  vec[ idx++ ] = _clamp01( _metric( state, 'affect.arousal', 0.3 ) )
  vec[ idx++ ] = _clamp01( _metric( state, 'affect.dominance', 0.5 ) )

  // ── Top-10 goal priorities ───────────────────────────────
  idx = _topEntityScalars( state, 'goal', 'priority', 0, vec, idx, 10 )

  // ── Top-10 belief confidences ────────────────────────────
  idx = _topEntityScalars( state, 'belief', 'confidence', 0.5, vec, idx, 10 )

  // ── Top-10 working-memory activations ────────────────────
  idx = _topEntityScalars( state, 'working_memory.item', 'activation', 0, vec, idx, 10 )

  // Defensive: zero-fill any remaining slots (never expected).
  while( idx < FINGERPRINT_DIM ) vec[ idx++ ] = 0

  return vec
}

/**
 * Collect a metadata scalar from every entity of `type`, sort descending,
 * and write the top `count` (clamped to [0,1]) into `vec` starting at `idx`.
 * Sorting makes the slice order deterministic regardless of Map iteration.
 * Returns the next free index.
 */
function _topEntityScalars(
  state: ReadonlySimulationState,
  type: string,
  field: string,
  fallback: number,
  vec: Float32Array,
  idx: number,
  count: number,
): number {
  const vals: number[] = []
  for( const e of state.entities.values() ){
    if( e.type !== type ) continue
    const raw = e.metadata?.[ field ]
    vals.push( typeof raw === 'number' ? raw : fallback )
  }
  vals.sort( ( a, b ) => b - a )
  for( let i = 0; i < count; i++ )
    vec[ idx++ ] = _clamp01( vals[ i ] ?? 0 )
  return idx
}

function _metric( state: ReadonlySimulationState, key: string, fallback: number ): number {
  const v = state.metrics.get( key )
  return typeof v === 'number' ? v : fallback
}

/** Normalise a value from [min,max] → [0,1]. */
function _norm( v: number, min: number, max: number ): number {
  if( max === min ) return 0.5
  return Math.max( 0, Math.min( 1, ( v - min ) / ( max - min ) ) )
}

function _clamp01( v: number ): number {
  if( Number.isNaN( v ) ) return 0
  return Math.max( 0, Math.min( 1, v ) )
}

/** Cosine similarity between two fingerprint vectors. */
export function fingerprintSimilarity( a: Float32Array, b: Float32Array ): number {
  let dot = 0, na = 0, nb = 0
  for( let i = 0; i < FINGERPRINT_DIM; i++ ){
    const ai = a[ i ] ?? 0
    const bi = b[ i ] ?? 0
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  const denom = Math.sqrt( na ) * Math.sqrt( nb )
  return denom === 0 ? 0 : dot / denom
}

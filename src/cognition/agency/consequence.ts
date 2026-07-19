// ─────────────────────────────────────────────────────────────
// src/agency/consequence.ts  —  expected-consequence descriptors
// ─────────────────────────────────────────────────────────────
//
// EXAFFERENCE P1. The efference copy predicts an action's *reward*; a
// consequence descriptor predicts its *sensory footprint* — what the world will
// look like because we acted. The MotorSchemaExecutor registers one at the
// enaction moment for world-facing actions only (delivered communicate, or the
// async communicate/external hold); sync innate enactions have internal effects
// and get none. Descriptors are ordinary entities, so they snapshot/restore and
// replay with the state (FN9), and they expire on a tick-denominated TTL that
// deliberately OUTLIVES intent resolution — a host ack does not stop the
// channel echo from arriving two ticks later.
//
// Dark in P1: written and expired, consumed by nothing. P2's corollary-
// discharge matcher reads them to tag percept provenance
// ('reafferent' | 'exafferent') and attenuate self-caused salience.
// Matching stays deterministic: FNV-1a content hashes, no clocks, no RNG.
// ─────────────────────────────────────────────────────────────

import type { EntityInput, Tick } from '#core/types'

export const CONSEQUENCE_TYPE = 'agency.consequence'

/**
 * Ticks a descriptor stays live — 2 × the executor's `AWAIT_TIMEOUT`, so a
 * descriptor survives both a stranded await (15 ticks) and the late sensory
 * echo of an already-reconciled action.
 */
export const CONSEQUENCE_TTL_TICKS = 30

export interface ConsequenceDescriptor {
  /** The enacting intent — sensory reafference can reconcile to it (P5). */
  intentId:        string
  schema:          string
  mode:            'communicate' | 'external'
  /** Communication effector name (talk/text/gesture/broadcast), when known. */
  effector?:       string
  targetEntityId?: string
  /** FNV-1a over the authored outbound text (delivered communicate). */
  textHash?:       number
  /** FNV-1a over the canonicalized parameters (async dispatch). */
  paramsHash?:     number
  expiresAt:       Tick
  tick:            Tick
}

/** Deterministic 32-bit FNV-1a — the shared content-match key (P2 matcher uses the same). */
export function fnv1a( text: string ): number {
  let h = 0x811c9dc5
  for( let i = 0; i < text.length; i++ ){
    h ^= text.charCodeAt( i )
    h = Math.imul( h, 0x01000193 ) >>> 0
  }
  return h >>> 0
}

/**
 * Canonicalize parameters into a stable string before hashing: keys sorted
 * recursively so `{a,b}` and `{b,a}` produce the same key. Deterministic and
 * cheap; not a serialization format (never parsed back).
 */
export function paramsKey( value: unknown ): string {
  if( value === null || typeof value !== 'object')
    return typeof value === 'string' ? JSON.stringify( value ) : String( value )
  if( Array.isArray( value ) )
    return `[${ value.map( paramsKey ).join(',') }]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys( obj ).sort()
  return `{${ keys.map( k => `${ k }:${ paramsKey( obj[k] ) }` ).join(',') }}`
}

/** Build the descriptor entity (id keyed by intent — one footprint per enaction). */
export function consequenceEntity( d: ConsequenceDescriptor ): EntityInput {
  return {
    id:   `agency-consequence-${ d.intentId }`,
    type: CONSEQUENCE_TYPE,
    metadata: { ...d },
  }
}

/** Read a descriptor back off entity metadata (P2 matcher + tests). */
export function readConsequence(
  m: ReadonlyMap<string, unknown> | Record<string, unknown> | undefined,
): ConsequenceDescriptor | null {
  const meta = ( m ?? {} ) as Record<string, unknown>
  const intentId = typeof meta['intentId'] === 'string' ? meta['intentId'] as string : undefined
  const schema   = typeof meta['schema']   === 'string' ? meta['schema']   as string : undefined
  const mode     = meta['mode'] === 'communicate' || meta['mode'] === 'external' ? meta['mode'] : undefined
  if( !intentId || !schema || !mode ) return null
  return {
    intentId, schema, mode,
    effector:       typeof meta['effector']       === 'string' ? meta['effector']       as string : undefined,
    targetEntityId: typeof meta['targetEntityId'] === 'string' ? meta['targetEntityId'] as string : undefined,
    textHash:       typeof meta['textHash']       === 'number' ? meta['textHash']       as number : undefined,
    paramsHash:     typeof meta['paramsHash']     === 'number' ? meta['paramsHash']     as number : undefined,
    expiresAt:      typeof meta['expiresAt']      === 'number' ? meta['expiresAt']      as number : 0,
    tick:           typeof meta['tick']           === 'number' ? meta['tick']           as number : 0,
  }
}

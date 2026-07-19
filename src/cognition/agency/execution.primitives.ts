// ─────────────────────────────────────────────────────────────
// src/agency/execution.primitives.ts  —  the bodies of primitive schemas
// ─────────────────────────────────────────────────────────────
//
// A primitive schema's "body" is what actually happens when it is enacted.
// Three execution modes:
//
//   • sync        — internal stances (orient, rest, reflect, …) resolve this
//                   tick. Following the original "attentional directive" insight,
//                   these are reportorial: they yield an honest outcome grounded
//                   in body state and DO NOT directly mutate regulated metrics
//                   (energy/stress are owned by the regulators — we don't fight
//                   them). Wiring stance→regulator signals is a later concern.
//   • communicate — an outward message; dispatched now, confirmed later (async).
//   • external    — a host-owned effector; emitted now, acked later (async).
//
// Composite schemas never reach here — the executor expands them into ordered
// primitive sub-intents.
// ─────────────────────────────────────────────────────────────

import type { MotorSchema } from '#agency/types'

export type EnactionMode = 'sync' | 'communicate' | 'external'

export interface Enaction {
  mode:           EnactionMode
  success:        boolean
  /** 0..1 actual outcome quality (provisional for async — refined on reconciliation). */
  outcomeQuality: number
  /** −1..1 actual felt valence of the outcome. */
  valence:        number
  description:    string
  /** Minimal, non-regulated metric nudges this stance legitimately owns. */
  metricDeltas?:  Array<[ string, number ]>
}

export interface EnactionContext {
  schema:          MotorSchema
  parameters:      Record<string, unknown>
  targetEntityId?: string
  energy:          number   // 0..100
  stress:          number   // 0..100
}

const COMM_SCHEMAS = new Set([ 'reach-out', 'talk', 'text', 'broadcast', 'gesture' ])

/** Classify how a primitive schema executes. */
export function modeOf( schema: MotorSchema ): EnactionMode {
  if( schema.tags?.includes('external') ) return 'external'
  if( schema.tags?.includes('communication') || COMM_SCHEMAS.has( schema.id ) ) return 'communicate'
  return 'sync'
}

/** Enact a primitive schema, producing a state-grounded outcome. */
export function enact( ctx: EnactionContext ): Enaction {
  const mode = modeOf( ctx.schema )

  if( mode === 'communicate'){
    const name = str( ctx.parameters['targetEntityName'] ) ?? ctx.targetEntityId ?? 'them'
    return {
      mode, success: true, outcomeQuality: 0.7, valence: 0.1,
      description: `I reach toward ${ name }. The words are sent; their effect is not yet known.`,
    }
  }

  if( mode === 'external')
    return {
      mode, success: true, outcomeQuality: 0.5, valence: 0,
      description: `"${ ctx.schema.id }" dispatched to the host; awaiting the world's reply.`,
    }

  return syncStance( ctx )
}

// ── sync stance bodies ───────────────────────────────────────────────────────

function syncStance( ctx: EnactionContext ): Enaction {
  const { schema, parameters, energy, stress } = ctx
  const e01 = clamp01( energy / 100 )
  const s01 = clamp01( stress / 100 )

  switch( schema.id ){
    case 'rest':
      // More restorative the more depleted the Will was.
      return sync( 0.5 + ( 1 - e01 ) * 0.4, 0.15, 'I let myself recover; the pressure eases a little.')
    case 'withdraw':
      return sync( 0.5 + s01 * 0.3, 0.05 + s01 * 0.1, 'I pull back from the press of things; the world quietens.')
    case 'reflect':
      return sync( 0.6, 0.05, 'I turn inward; patterns from recent events settle into place.')
    case 'attend':
      return sync( 0.6, 0.0, 'I concentrate, mobilizing more of my attention.')
    case 'orient':
      return sync( 0.5, 0.0, 'My awareness sweeps the situation, taking its measure.')
    case 'wait':
      return sync( 0.5, 0.0, 'I let time pass; regulatory processes continue their quiet work.')
    case 'express':
      return sync( 0.6, 0.1, 'My inner state becomes outwardly visible.')
    case 'inspect': {
      const focus = str( parameters['focus'] ) ?? 'it'
      return sync( 0.65, 0.05, `I examine ${ focus } closely; more of its detail resolves.`)
    }
    default:
      return sync( 0.5, 0.0, `I enact ${ schema.id }.`)
  }
}

function sync( outcomeQuality: number, valence: number, description: string ): Enaction {
  return { mode: 'sync', success: true, outcomeQuality: clamp01( outcomeQuality ), valence, description }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function str( v: unknown ): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function clamp01( n: number ): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

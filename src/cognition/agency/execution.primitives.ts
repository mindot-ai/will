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
  /**
   * True when the target is something the WORLD holds an address for.
   *
   * Set by the executor, which can see the alias table. It is what decides
   * whether `inspect` is a question put outward or a look inward — see the note
   * on the innate schema. Absent means "not externally addressable", which is the
   * honest default: a mind examining something it only holds internally.
   */
  worldAddressable?: boolean
  /**
   * True when the mind actually holds a record of the target.
   *
   * Looking inward at something you have nothing about is not a quiet success,
   * it is coming back empty. Live, a 22-tick-old Will inspected
   * `affordance-1-orient-orient` — one of its OWN affordance entities — and was
   * told it went well.
   */
  heldDetail?: boolean
  /**
   * True when this same target was inspected recently.
   *
   * The second look at an unchanged thing resolves nothing further, and saying
   * otherwise is what let `inspect` proceduralize into a habit (0.64) fifteen
   * ticks after birth, before anyone had spoken to her.
   */
  alreadyLooked?: boolean
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
  // `inspect` is the one act whose mode belongs to its OBJECT rather than to
  // itself: looking at a room is a question for the world, looking at a memory is
  // not. Everything else is classified by its tags alone.
  const mode = ctx.schema.id === 'inspect' && ctx.worldAddressable
    ? 'external'
    : modeOf( ctx.schema )

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
    // Looking inward — the target is something the mind holds, not something the
    // world can be asked about. It reports what is actually there.
    //
    // The version this replaces returned success 0.65 with "more of its detail
    // resolves" for EVERY inspect, and nothing ever resolved. Reafference scores
    // what it is told, so a mind that looked and learned nothing was taught that
    // looking works — habit and value climbing with each futile repetition. The
    // failure arm below is the point of the fix, not an edge case: a mind must be
    // able to find out that there is nothing more to find out.
    // Looking inward, and able to come back empty — which is the whole point.
    //
    // Two versions of this shipped and both were the same lie. The first returned
    // success 0.65 with "more of its detail resolves" for every inspect. The
    // second required a name, which the percept binding always supplies, so it
    // also always succeeded. Reafference rewards a reliably-successful act, so a
    // fresh Will proceduralized `inspect` to habit 0.64 within fifteen ticks and
    // spent five of its first eight decisions on it, examining its own affordance
    // entities and learning nothing.
    //
    // The defect was never the condition, it was that an internal look had no way
    // to FAIL. "Take in what I already hold" is always possible, so it was not an
    // act with an outcome, it was a no-op that reported success. A mind must be
    // able to find out that there is nothing to find out.
    case 'inspect': {
      const held = str( parameters['targetEntityName'] ) ?? str( parameters['focus'] )
      if( !held )
        return look( false, 'I go to examine something and find nothing named to examine.')
      if( ctx.heldDetail === false )
        return look( false, `I turn my attention to ${ held } and find I hold no record of it.`)
      if( ctx.alreadyLooked )
        return look( false, `I look at ${ held } again and find nothing I did not already have.`)
      return sync( 0.6, 0.05, `I turn my attention to ${ held }; what I hold of it comes into view.`)
    }
    default:
      return sync( 0.5, 0.0, `I enact ${ schema.id }.`)
  }
}

/** A look that found nothing. Low quality and mildly negative, so reafference
 *  erodes the habit instead of building it — an empty look must cost something. */
function look( _found: false, description: string ): Enaction {
  return { mode: 'sync', success: false, outcomeQuality: 0.15, valence: -0.05, description }
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

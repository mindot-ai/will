// ─────────────────────────────────────────────────────────────
// src/cognition/senses/somatosensation.engine.ts
// ─────────────────────────────────────────────────────────────

/**
 * SomatosensationEngine — the sense that feels things happen TO the mind.
 *
 * Webhooks, system signals, external callbacks: not something said, not
 * something seen, but the world touching the mind directly. It was the first
 * shell to be implemented because the wake event needed a door — SIGNAL_BOUNDARY
 * P1 — and a hand-written percept in `stem/index.ts` was the bypass that proved
 * the door was missing.
 *
 * WHAT MAKES THIS A SENSE RATHER THAN A HELPER. It does nothing the other senses
 * do not: transduce an input into a `Percept` with a salience and a summary, and
 * hand it to `publishPercept`, which stamps provenance from the host's assertion
 * and lays down the trace. Everything downstream — the rupture gate, working
 * memory, the executive prompt, novelty — receives it because it is a percept,
 * not because anyone wired those five places to a wake event.
 *
 * That is the whole point of a door: the wake event stops being special.
 */

import type { SensoryInput, SystemSignal, WebhookEvent, Percept, Transduced } from '#senses/index'
import { BaseSenseEngine } from '#senses/base.sense.engine'
import { PERCEPT_SUMMARY_CAP } from '#cognition/percept.entity'

/**
 * How loud a system signal is by default.
 *
 * A signal arrives because something HAPPENED to the mind — a host woke it, a
 * webhook fired — so it outranks the ambient world-change percepts
 * `exteroception` produces at 0.3, and clears `action.selector`'s rupture gate
 * (0.4). A host that knows better says so with `salience` on the input.
 */
export const SYSTEM_SIGNAL_SALIENCE = 0.75

export class SomatosensationEngine extends BaseSenseEngine {
  readonly name   = 'somatosensation-engine'
  readonly domain = 'somatosensation' as const
  protected readonly acceptedKinds = new Set<SensoryInput['kind']>( [ 'webhook', 'system' ] )

  protected async _perceive( input: SensoryInput ): Promise<void> {
    const percept: Transduced<Percept> = input.kind === 'system'
      ? this._fromSignal( input as SystemSignal )
      : this._fromWebhook( input as WebhookEvent )

    this.publishPercept( percept, input )
  }

  private _fromSignal( s: SystemSignal ): Transduced<Percept> {
    return {
      domain:         this.domain,
      // The signal IS the source: nothing in the world sent it, the substrate did.
      sourceEntityId: `system:${ s.signal }`,
      timestamp:      0,
      salience:       salienceOf( s.data, SYSTEM_SIGNAL_SALIENCE ),
      summary:        labelFor( s.signal, s.data ),
      ...( s.data !== undefined && s.data !== null ? { data: s.data } : {} ),
      raw:            s,
    }
  }

  private _fromWebhook( w: WebhookEvent ): Transduced<Percept> {
    return {
      domain:         this.domain,
      sourceEntityId: `webhook:${ w.source }`,
      timestamp:      0,
      salience:       salienceOf( w.payload, SYSTEM_SIGNAL_SALIENCE ),
      summary:        labelFor( w.source, w.payload ),
      ...( w.payload !== undefined && w.payload !== null ? { data: w.payload } : {} ),
      raw:            w,
    }
  }
}

/**
 * A LABEL for a signal — what arrived, not what it means.
 *
 * The mind makes the meaning; this only has to make the percept legible enough
 * to be noticed and connected to its data. A HOST IS NEVER ASKED FOR PROSE:
 * demanding a sentence from a robot's control layer puts the mind's own work on
 * the wrong side of the integration boundary, and a lidar driver has no business
 * describing what a scan implies.
 *
 * The signal's own NAME is the hint, and it is free — `discord_server_snapshot`,
 * `WAKE`, `lidar.scan` already say what kind of thing this is. A host that
 * happens to have words may put a `summary` on its data and they are used
 * instead; it is an option, never an obligation.
 *
 * Bounded by `PERCEPT_SUMMARY_CAP` because the ENGINE writes it. The data it
 * labels is beside it, whole and uncapped.
 */
function labelFor( signal: string, data: unknown ): string {
  const words = hostWords( data )
  if( words ) return words.length > PERCEPT_SUMMARY_CAP
    ? `${ words.slice( 0, PERCEPT_SUMMARY_CAP - 1 ) }\u2026` : words

  const rendered = compact( data )
  const label = rendered ? `${ signal }: ${ rendered }` : `Something happened: ${ signal }.`
  return label.length > PERCEPT_SUMMARY_CAP
    ? `${ label.slice( 0, PERCEPT_SUMMARY_CAP - 1 ) }\u2026` : label
}

/** A host's own words, if it chose to offer any. Optional, never required. */
function hostWords( data: unknown ): string | undefined {
  if( typeof data === 'string') return data.length > 0 ? data : undefined
  if( typeof data === 'object' && data !== null && !Array.isArray( data ) ){
    const s = ( data as Record<string, unknown> )['summary']
    if( typeof s === 'string' && s.length > 0 ) return s
  }
  return undefined
}

/** A glance at the shape, for the label only. The whole thing rides in `data`. */
function compact( data: unknown ): string | undefined {
  if( data === undefined || data === null ) return undefined
  if( typeof data !== 'object') return String( data )
  try {
    const json = JSON.stringify( data )
    return json === '{}' || json === '[]' ? undefined : json
  }
  catch { return undefined }   // circular — the label falls back to the name
}

/** Same door for salience: the host may say, otherwise the default stands. */
function salienceOf( data: unknown, fallback: number ): number {
  if( typeof data !== 'object' || data === null || Array.isArray( data ) ) return fallback
  const s = ( data as Record<string, unknown> )['salience']
  return typeof s === 'number' && Number.isFinite( s ) ? Math.max( 0, Math.min( 1, s ) ) : fallback
}

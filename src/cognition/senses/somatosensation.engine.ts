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
      summary:        summaryOf( s.data ) ?? `Something happened: ${ s.signal }.`,
      raw:            s,
    }
  }

  private _fromWebhook( w: WebhookEvent ): Transduced<Percept> {
    return {
      domain:         this.domain,
      sourceEntityId: `webhook:${ w.source }`,
      timestamp:      0,
      salience:       salienceOf( w.payload, SYSTEM_SIGNAL_SALIENCE ),
      summary:        summaryOf( w.payload ) ?? `${ w.source } sent something.`,
      raw:            w,
    }
  }
}

/**
 * Render a signal's `data` into the words the mind reads — WHOLE, never cut.
 *
 * `summary` is the only field the executive prompt renders, so this is where an
 * arbitrary payload becomes readable. Three shapes, in order of how much the
 * host has told us:
 *
 *   • `data.summary` — the host said it in words. Use its words.
 *   • a bare string  — it is already words.
 *   • anything else  — JSON, complete. Ugly in a prompt and honest: a host that
 *     wants prose sends prose, and one that has a record sends the record. What
 *     it may not do is lose half of it on the way in, which is what a cap here
 *     would mean — this is the only copy.
 *
 * Nothing is truncated. The engine bounds what the ENGINE composes
 * (`PERCEPT_SUMMARY_CAP`, for summaries it writes about world-changes); it does
 * not bound what a host sent.
 */
function summaryOf( data: unknown ): string | undefined {
  if( data === undefined || data === null ) return undefined
  if( typeof data === 'string') return data.length > 0 ? data : undefined

  if( typeof data === 'object'){
    const s = ( data as Record<string, unknown> )['summary']
    if( typeof s === 'string' && s.length > 0 ) return s
    try {
      const json = JSON.stringify( data )
      // `{}` and `[]` are a host saying nothing, not a host saying "nothing".
      // Rendering them would put a pair of braces in front of the mind where
      // the signal's own name is more informative.
      return json === '{}' || json === '[]' ? undefined : json
    }
    catch { return undefined }   // circular — nothing readable to offer
  }

  return String( data )
}

/** Same door for salience: the host may say, otherwise the default stands. */
function salienceOf( data: unknown, fallback: number ): number {
  if( typeof data !== 'object' || data === null || Array.isArray( data ) ) return fallback
  const s = ( data as Record<string, unknown> )['salience']
  return typeof s === 'number' && Number.isFinite( s ) ? Math.max( 0, Math.min( 1, s ) ) : fallback
}

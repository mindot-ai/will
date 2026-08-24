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
 * A host may put `summary` on the signal's `data` to say, in words, what
 * happened. Without it the mind gets the signal NAME, which is honest but
 * thin — `Something happened: WAKE.` is not much to reason from, and the
 * summary is the only field the executive prompt renders.
 */
function summaryOf( data: unknown ): string | undefined {
  if( typeof data !== 'object' || data === null ) return undefined
  const s = ( data as Record<string, unknown> )['summary']
  return typeof s === 'string' && s.length > 0 ? s : undefined
}

/** Same door for salience: the host may say, otherwise the default stands. */
function salienceOf( data: unknown, fallback: number ): number {
  if( typeof data !== 'object' || data === null ) return fallback
  const s = ( data as Record<string, unknown> )['salience']
  return typeof s === 'number' && Number.isFinite( s ) ? Math.max( 0, Math.min( 1, s ) ) : fallback
}

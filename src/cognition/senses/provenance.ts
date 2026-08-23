// ─────────────────────────────────────────────────────────────
// src/cognition/senses/provenance.ts
// ─────────────────────────────────────────────────────────────

/**
 * Signal provenance — the boundary vocabulary for "whose doing was this?"
 * (SIGNAL_BOUNDARY P0a).
 *
 * Its own module, not part of `senses/index`, for one concrete reason:
 * `BaseSenseEngine` needs the VALUE `provenanceOf` at the emit chokepoint, and
 * `senses/index` re-exports `BaseSenseEngine` — importing it from there would
 * be a runtime import cycle rather than the erased type-only one that was there
 * before. `senses/index` re-exports everything here, so the public path is
 * unchanged.
 */

/**
 * Whether a signal arriving at the senses was caused by this mind's own
 * efference (SIGNAL_BOUNDARY P0a).
 *
 *   • 'exafferent' — the world did this. Nothing of mine preceded it.
 *   • 'reafferent' — I did this, and I am now sensing the consequence.
 *   • 'unknown'    — the host cannot say. ASSERTED, never inferred.
 *
 * WHY THE DEFAULT IS 'exafferent' AND NEVER 'reafferent'. A percept wrongly
 * marked as mine is attenuated on the exafference path and can never rupture a
 * commitment — so a mind that mislabels the world as its own doing goes quiet
 * about real events, which is the failure that matters. Erring the other way
 * costs only a little redundant salience. Same shape of argument as
 * `asFinality()` refusing to default to `'context'`: the value that makes the
 * mind learn LESS must be claimed by someone who knows, not fallen into.
 *
 * A host that genuinely cannot tell should say `'unknown'` out loud rather than
 * leave the field off — an omission reads as a decision nobody made.
 */
export type SignalProvenance = 'exafferent' | 'reafferent' | 'unknown'

/**
 * What EVERY sensory signal carries, whatever kind it is — the provenance stamp.
 *
 * It lives on the input rather than being derived downstream because only the
 * host knows. A Discord bridge knows that the message it just received is the
 * webhook echo of the message the mind sent; nothing inside the mind can tell
 * that from a stranger saying the same words. So the boundary asserts it, and
 * the mind trusts the assertion — the same contract as `speakerName` (a name is
 * learned from the host, never guessed) and `direct` (an unknown room is not
 * known to be public).
 */
export interface SensorySignal {
  /** Mine or the world's. Omitted reads as `'exafferent'` — see `provenanceOf`. */
  provenance?:     SignalProvenance
  /**
   * The `agency.intent` id this is the consequence of. Only meaningful when
   * `provenance` is `'reafferent'`; the correlation handle a later mechanism
   * needs to ask *"is this the echo of that?"* (`ACT_EXPECTATIONS`).
   */
  sourceIntentId?: string
}

/**
 * The one place the default lives. A host that says nothing is treated as
 * having sensed the world, never as having sensed itself.
 */
export function provenanceOf( input: SensorySignal ): SignalProvenance {
  return input.provenance ?? 'exafferent'
}


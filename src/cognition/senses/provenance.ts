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
 *   • 'unknown'    — the source cannot say.
 *
 * There is no fourth, silent state — see `SensorySignal`.
 *
 * ONE CONCEPT, TWO WAYS OF ARRIVING AT IT. This type is shared with the percept
 * entities `exteroception` and `outbox.controller` write, which used the same
 * two spellings before it existed (EXAFFERENCE P2/P3), and it is deliberately
 * not "asserted only":
 *
 *   • At the WORLD door, provenance is INFERRED and that is correct — the mind
 *     holds both sides. `Exteroception` matches an observed change against its
 *     own live consequence descriptors (`matchConsequenceText` /
 *     `matchConsequenceEntity`) and tags the hit `'reafferent'`.
 *   • At the SENSE door, provenance must be ASSERTED — there is nothing to
 *     match against. A host's Discord message and the mind's own echo of it are
 *     identical from the inside; only the host can tell them apart.
 *
 * What the two share is the consequence, and it is load-bearing:
 * `action.selector`'s rupture gate counts only `'exafferent'` percepts, so
 * anything tagged (or defaulted) as mine can never rupture a commitment.
 */
export type SignalProvenance = 'exafferent' | 'reafferent' | 'unknown'

/**
 * What EVERY sensory signal carries, whatever kind it is — the provenance stamp.
 *
 * It lives on the input rather than being derived downstream because only the
 * host knows. A Discord bridge knows that the message it just received is the
 * webhook echo of the message the mind sent; nothing inside the mind can tell
 * that from a stranger saying the same words. So the boundary asserts it, and
 * the mind trusts the assertion.
 *
 * WHY `provenance` IS REQUIRED AND HAS NO DEFAULT. It shipped optional first,
 * defaulting to `'exafferent'`, and that was wrong for a reason worth keeping
 * written down. This codebase makes a field optional when absence is the ONLY
 * way to say a third thing: `speakerName?` (no string means "no name learned"),
 * `direct?` (no boolean means "the channel did not say"). Provenance already
 * HAS its third thing — `'unknown'`. So optionality bought a fourth state that
 * was behaviourally identical to `'exafferent'` and epistemically its opposite:
 * a claim that the world did this, made by nobody. Worse, it was lossy in the
 * one direction that costs — a reader could never separate "the host asserts
 * exafference" from "the host said nothing", which want different treatment
 * downstream, and `'unknown'` exists precisely to keep them apart.
 *
 * The related-but-different precedent is `asFinality()`. That one DOES default,
 * because it normalizes an `unknown` read back off entity metadata or a host
 * ack, where the type system cannot help and something must be chosen. Here the
 * type system can help, so it does. Should provenance ever need reading off a
 * tape, that reader gets its own `asFinality`-shaped normalizer, and the
 * direction of ITS fallback is `'exafferent'`: a percept wrongly marked as mine
 * is attenuated and can never rupture a commitment, so a mind that mislabels
 * the world as its own doing goes quiet about real events. Erring the other way
 * costs only a little redundant salience.
 *
 * `sourceIntentId` stays optional by the same rule that made `provenance`
 * required: there is no id meaning "no intent", so absence is the only way to
 * say it, and it is meaningless unless `provenance` is `'reafferent'`.
 */
export interface SensorySignal {
  /** Mine, the world's, or honestly unknown. Asserted by the host — never inferred. */
  provenance:      SignalProvenance
  /**
   * The `agency.intent` id this is the consequence of. Only meaningful when
   * `provenance` is `'reafferent'`; the correlation handle a later mechanism
   * needs to ask *"is this the echo of that?"* (`ACT_EXPECTATIONS`).
   */
  sourceIntentId?: string
}

/**
 * A percept as a sense engine BUILDS it — provenance omitted, because it is not
 * the engine's to write. `publishPercept()` applies the host's assertion, so
 * this type is what makes laundering a compile error rather than a runtime one.
 */
export type Transduced<P extends { provenance: SignalProvenance }> =
  Omit<P, 'provenance' | 'sourceIntentId'>

/**
 * Normalize an UNTYPED provenance — one arriving over a protocol the type
 * system cannot police: an MCP tool call, an HTTP body, a wire envelope, a
 * value read back off a snapshot.
 *
 * This is the `asFinality()` situation, and the ONLY situation in which
 * provenance has a default. Inside the package the field is required, because
 * there the compiler can make a producer answer. At an untyped boundary it
 * cannot, something must be chosen, and every such read goes through here
 * rather than comparing string literals at the call site.
 *
 * THE DEFAULT IS 'exafferent', AND NEVER 'reafferent'. A percept wrongly marked
 * as mine is attenuated on the exafference path and can never rupture a
 * commitment — so a mind that mislabels the world as its own doing goes quiet
 * about real events, which is the failure that matters. Erring the other way
 * costs only a little redundant salience. 'reafferent' is a claim only a caller
 * that actually knows can make.
 *
 * Note it does NOT fall back to 'unknown', which would be the tidy-looking
 * choice. 'unknown' is an assertion too — "I looked and I cannot tell" — and a
 * caller that simply did not send the field has not looked. Where the ABSENCE
 * is structural rather than a caller's omission (a wire envelope with no such
 * field), say 'unknown' at that site explicitly instead of routing through here.
 */
export function asProvenance( raw: unknown ): SignalProvenance {
  return raw === 'reafferent' ? 'reafferent'
       : raw === 'unknown'    ? 'unknown'
       : 'exafferent'
}

# Record anchoring — tamper-evident decision records (parked, do not lose)

> **Status:** OPEN — parked 2026-07-08 so it survives context loss. Small,
> high-leverage: it upgrades our audit story from "operator-trusted logs" to
> "tamper-evident records verifiable without trusting the operator", with no
> blockchain and no new dependency.

## Why (the Cinchor finding, 2026-07-08)

Analysis of cinchor.com ("accountability infrastructure for autonomous
agents": `enforce` + `attest` on their own L1) concluded we already cover
their "bound before" (structural capability gating) and exceed their "proven
after" in one dimension — deterministic replay proves the CAUSAL CHAIN (the
white-box *why*), where they attest a black-box receipt. The ONE thing they
have that we lack: **a trust root outside the operator.** Our session logs,
decision records and replay transcripts are operator-held files — a court or
insurer must trust whoever ran the Will.

This item closes that gap and neutralizes most of the `attest`
differentiation while keeping the replay advantage they cannot match.
Strategic pairing: "replayable mind inside, attested actions outside" —
Cinchor (or anything like it) integrates at the effector ack boundary, it
does not compete with the cognition layer. EU-wedge relevance: replay-audit
+ tamper-evidence is the compliance story.

## Design sketch (deliberately boring crypto)

1. **Hash-chain the record streams.** Each session-log line / decision record
   / completion-transcript entry gains `prev_hash` + `hash =
   sha256(prev_hash ‖ canonical_json(record))`. One chain per Will per
   stream, genesis = hash of the Will's config + seed. Cheap (sync sha256),
   append-only, any retro-edit breaks the chain from that point forward.
2. **Periodic signed digest.** Every N ticks (and at hibernate) emit a
   `digest` record: `{ willId, tick, heads: {session, decisions,
   completions}, pma_hash? }`, signed ed25519 with a host key (key
   generation + storage = host concern; the engine just signs if a key is
   configured).
3. **External anchoring (the trust root).** Publish the signed digest hash
   anywhere append-only the operator does not control: a public git repo
   commit, an RFC-3161 timestamping service, or sigstore/Rekor (we already
   touch sigstore via npm provenance). Pluggable `anchor(digest)` hook; ship
   the git and file adapters, document the rest.
4. **Verification CLI.** `will verify <records-dir>` — walks the chains,
   checks signatures, compares against anchored digests, and (flagship move)
   optionally REPLAYS the completion transcript and confirms the recorded
   decisions reproduce byte-for-byte. That last step is the thing nobody
   attest-only can offer.

## Scope notes

- Engine touchpoints: session.logger (chain), a small `core/record.chain.ts`,
  stem hibernate path (final digest), CLI subcommand.
- NOT in scope: key management UX, on-chain anything, per-record signing
  (digest-level is enough), backend/Studio surfacing (follow-up).
- Tests: chain integrity (edit any line → verify fails from there), digest
  determinism under fixed seed, verify-CLI happy/tamper paths.

## Related

- `.TODO/AUDITION_REPLY_DETERMINISM.md` (RESOLVED) — conversational replay is
  byte-identical, so step 4's replay check covers conversations too.
- Launch memory: launch-cycle → "CINCHOR ANALYSIS" + "REPLAY-AUDIT STORY
  COMPLETE" entries.

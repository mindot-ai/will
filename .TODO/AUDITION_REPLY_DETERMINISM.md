# Audition conversation-reply determinism + reliability gap

**Status:** OPEN — found 2026-07-05 while building the SDK facade (examples/effectors.ts).
**Severity:** medium — real, but masked in practice (a real executive + real percept
salience is far more reliable than the mock; the facade itself is correct).

## The gap

A conversation reply (`ingestText` → audition facet → outbox message) is **not
reliably produced under the mock executive**, and its timing is **non-deterministic
even with a fixed `randomSeed` + fixed clock**:

- Same config (seed 7, fixed clock, mock, `"Hello who are you?"`) across repeated
  fresh-process runs: one run produced NO reply within 12 s; the next replied at
  tick 168. Deterministic inputs, non-deterministic output.
- Reply presence is also sensitive to message *content* (`"Please remember X"` —
  read as an instruction — suppressed the reply where `"Hello who are you?"` did
  not) and to identity-prompt wording.

## Why it matters

1. **Determinism**: the R2-d replay capstone passes, but it exercises the MASTER
   executive path. The AUDITION conversation facet appears to retain a
   wall-clock/scheduler dependency the executive-facet pump (CompletionInbox +
   per-tick pump, see FACET_REPLAY_DETERMINISM.md) does not cover. If a
   conversation reply's issue/land tick can vary under a fixed seed, byte-identical
   replay does not hold for conversational Wills.
2. **Product reliability**: `say()` should reliably get a reply. Under the mock it
   is flaky; the concern is whether real-LLM conversation replies are ever
   similarly starved (e.g. the conversation facet losing an attention/salience race
   to a background executive cycle or a custom-effector schema).

## Suspected mechanism (unverified)

The audition facet's reasoning is gated by salience/attention. Under the mock the
language-percept salience may sit near the trigger threshold, so RNG/timing tips it
either way. A custom-effector schema in the repertoire made it worse — possibly the
action competition or attention budget starving the conversation facet.

## Fix directions

1. **Trace the audition facet through the tick-quantized pump.** Confirm whether
   audition facet reasoning launches from `FacetSupervisor.pump()` (deterministic)
   or still from a raw `report()` path (the layer-3 issue, but for audition).
2. **Guarantee a language percept crosses the reasoning threshold.** A direct
   conversation turn should not depend on ambient salience to get a reply — the
   percept itself should reliably recruit the facet.
3. **Add a conversation-path replay test** (peer to replay.equivalence) that
   records+re-feeds a scripted conversation and asserts byte-identical state, so
   this path is covered, not just the master executive.

## Re-enable / done criteria

A scripted conversation (ingestText → reply) is (a) deterministic under a fixed
seed across repeated runs, and (b) reliably produces a reply within a bounded tick
budget regardless of message phrasing or registered effectors.

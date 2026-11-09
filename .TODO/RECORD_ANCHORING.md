# Record anchoring — tamper-evident decision records

> **Standing:** DESIGNED · 2026-11-09 · partial — designed 2026-07-08 and settled against the engine 2026-11-09; steps 1–3 (the chain, digests, the `anchor()` hook) landed, unreleased; step 4 (the verify CLI and its replay check) open
>
> **2026-11-09:** the engine was read end to end against this sketch, and the
> design below settles each open choice. **Steps 1–3 (the chain, digests, the
> `anchor()` hook) are BUILT** — `core/record.chain.ts`, `core/record.tap.ts`,
> `stem/tracts/anchor.controller.ts`, and `anchoring` on `Will.create` /
> `Will.wake`. Step 4 (the verify CLI and its replay check) is next.

## Why

Determinism gives Will something no attestation log can offer: replay proves
the **causal chain** — same seed + same inputs re-executes the whole mind
byte-for-byte, so an auditor can confirm the recorded reasoning actually
*produces* the recorded action (the white-box *why*, not just a receipt that
something happened). One link is missing to make that audit-grade end to end:
**a trust root outside the operator.** Today the session logs, decision
records and replay transcripts are operator-held files — a court, insurer or
regulator must trust whoever ran the Will.

This item closes that gap. Anchored, hash-chained records + byte-for-byte
replay is the complete accountability story, in our own three verbs:
**gated** — an ability not granted has no motor schema and can never be
enacted, no matter how the mind is prompted; **evidenced** — tamper-evident
records anyone can verify without trusting the operator; **explained** —
replay re-derives the decision itself. Receipt-style audit logs stop at the
second verb; the cognition layer is where the third one lives. EU-wedge
relevance: replay-audit + tamper-evidence is the compliance story.

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
   decisions reproduce byte-for-byte. That last step is ours alone.

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

---

## How the engine works today (read 2026-11-09)

What the design below has to fit, traced through the code rather than assumed.

**The four places a record is produced.**

| Record | Produced at | Reaches | Today |
| :--- | :--- | :--- | :--- |
| Session log entry | `SessionLogger.write` (`stem/tracts/session.logger.ts`); written by the executive, facets, planner, goals, motor executor, outbox writer, the tick loop (`tick`), and the stem's `subscribeAll`, which logs **every** bus event | the host as a `session_log` envelope on `config.transport`; a dev-only NDJSON file | Always written. **An SDK host never receives it**: `Will.create` sets no transport, so outside dev mode it goes nowhere |
| LLM completion (full prompt + text) | `LLMDirector._recordCompletion` (`llm/index.ts`) | `getCompletionRecorder(willId)` | Captured only while `ReplayController` is recording |
| External inbound envelope | `TransportController.applyInbound`, at the tick it is applied | `getInboundRecorder(willId)` | Same: only while recording, and only for transport hosts |
| Policy verdict | `PolicyEnforcement._recordAndApply` | `getVerdictRecorder(willId)` | **Never installed outside tests**: `ReplayController` routes completions and inbound, not verdicts |

Each of the three recorder registries holds **one** sink per Will, and
`ReplayController.start` replaces it. A second consumer installed the same way
would displace the replay recorder, or be displaced by it.

**The decision is already in the session log.** The motor executor emits
`agency.invocation` (`intentId`, `schema`, `parameters`, `tick`) inside the
step. The stem's `subscribeAll` logs it as a session `event` entry and then
hands it to the policy seam, so the decision is written before the arbiter
answers. A host's answers do not all come back the same way:
- An SDK host acks through `stem.confirmEffectorExecution` and answers an
  escalation through `stem.resolveEscalation`. Both are applied directly, not
  through the inbound recorder, so neither is on the replay tape (the second is
  POLICY_REAFFERENCE P4b's open item).
- The session log does record the ack (`effector.acked`).

**Two tick axes.**
- `instance.tickCount` is the harness counter. It restarts at 0 in every
  process.
- The simulation clock resumes from the snapshot's tick on restore
  (`clock.setTick`). `agency.invocation.tick`, and so `PolicyInvocation.tick`,
  is on this axis. A digest is compared with an act's tick, so it has to be on
  this one too.
- The orchestrator advances the clock at the start of `_executeTick`. The
  state snapshot taken after `step(1)` therefore carries the tick the step ran
  at.

**Lifecycle.**
- `createWill` opens a `SessionLogger`. `pauseWill` closes it, and
  `resumeWill` opens a new one with a new `sessionId`.
- `archiveWill` (behind `stop()` and `hibernate()`) writes `session.end`,
  stops the loop, and persists.
- `Will.wake` boots a new stem in a new process from a PMA artifact. Nothing
  durable about records crosses the boundary.

**Determinism rules the design must keep.**
- `tests/unit/determinism.guard.test.ts` bans `Date.now`, `new Date`,
  `Math.random` and `randomUUID` in `src/core` and `src/cognition`.
- The replay-equivalence tests compare a run's state byte for byte, with only
  `createdAt` excluded.
- Anchoring therefore writes nothing into simulation state, and its chain code
  reads no clock and no randomness.

## Design (decided 2026-11-09)

Settled after comparing it against the alternatives (below) and before any
code.

**1. One record chain per Will, four streams in it.**
- `session`: every session-log entry. It is the operator's narrative of the
  mind: every bus event, so every decision (`agency.invocation`), every
  executive call and output, every conversation, every ack.
- `completions`: every LLM completion, the oracle's answers replay re-feeds.
- `inbound`: every external envelope applied at a tick.
- `verdicts`: every arbiter verdict.

The stream is a field of each entry, not a chain of its own:
- one chain proves the order *across* streams, for example that a decision
  was written before its verdict, which four chains could only infer from
  ticks;
- it has one head, one sequence, and one value to resume from;
- a host can still store and retain each stream apart.

No separate "decisions" stream is added. The decision is already a session
entry, written before its verdict.

**2. VLX's hash contract, committing to the record's hash.** An entry is
`{ stream, seq, tick, prev, hash, recordHash, record? }`, where
- `recordHash = sha256hex(canonical(record))`, and
- `hash = sha256hex(prev + ':' + canonical({ stream, seq, tick, recordHash }))`.

The contract's details:
- `canonical` is VLX's hash contract v2 canonical JSON (keys sorted, no
  whitespace), written out here from its specification, not imported. A
  shared vector is asserted on both sides, so one verifier checks both
  chains.
- A record is reduced to its JSON form before it is hashed and handed on.
  What the host stores is exactly what was hashed, so it hashes the same
  after a round trip.
- The chain commits to the record's **hash**:
  - shredding a record's contents (draft-tier reasoning, VLX §3.5) leaves the
    chain verifiable;
  - one act can be shown to an auditor with only the hashes after it, never
    every later prompt.
- `seq`, `tick` and `stream` are in the material, so an entry cannot be
  renumbered, moved to another tick or relabelled without breaking its hash.
- `tick` is the simulation tick at which the entry was chained (point 4).

**3. Where a chain starts, and continuing one.** The first entry is a
`chain` entry whose record is
`{ chain: 'will-record/1', willId, seed, startTick }`:
- `prev` is VLX's `GENESIS_HASH`, 64 zeros, so the genesis convention is the
  contract's too.
- The sketch's "config + seed" is narrowed to the seed. The config holds a
  live API key and handler functions, and a woken mind's config legitimately
  differs; the seed is what replay needs.
- A host that wants one continuous chain across a wake passes the head it
  last persisted (`resume: { seq, hash }`). The `chain` entry then continues
  from it, with `resumed: true`.
- Without `resume`, a woken mind begins a chain whose `startTick` shows it is
  a new one, never a silent fork.

**4. Digests on the simulation tick.**
- A digest is `{ willId, tick, streamHeads: { records: <head hash> }, meta: { chain: 'will-record/1', seq } }`,
  the shape VLX takes a Will digest in.
- It is emitted after the step:
  - at the first tick, so a mind is anchored before its first act;
  - every `every` ticks;
  - at pause;
  - at archive, after `session.end`.
- `tick` is the simulation tick.
- Each entry's `tick` is read from the simulation clock when it is chained.
  A digest at tick T therefore covers everything chained up to the end of
  step T.
- If the host supplies `sign(material)`, the digest is signed over
  `canonical(digest)`. The engine never holds a key.

**5. The hook is off the tick loop.**
- `anchor(digest, signature?)` may return a promise. The loop does not wait
  for it.
- A failure is reported on the `error` event. The next digest supersedes it,
  because heads are cumulative.
- `record(entry)` receives every chained entry, synchronously and in order. It
  is required: heads with no records to check them against verify nothing.

**6. Taps that sit beside the recorders.** Anchoring gets its own per-Will
tap (`core/record.tap.ts`) at the same four capture sites, without replacing the replay recorders,
so recording a replay and anchoring never displace each other. Each capture
site builds its record when either is present. The session tap sits in the
stem's `attachEmit` bridge: one helper used by both `createWill` and
`resumeWill`, so the two cannot drift.

**7. The SDK.** `Will.create` and `Will.wake` take
`anchoring?: { every, record, anchor, sign?, resume? }`. The package exports
`verifyChain(entries, from)`, which returns `{ valid, breakpoint }`, because
the tests need it and it is the core of step 4.

**Tests**, each one mutation-tested:
- tampering with any field of any entry breaks the chain at that `seq`, as do
  reordering and dropping;
- canonical-JSON vectors shared with VLX;
- digest cadence on the simulation tick, including after a restore;
- one test per crossing: a session entry, a completion, an inbound envelope
  and a verdict each reach `record`;
- replay recording and anchoring both receive every record;
- replay equivalence holds byte for byte with anchoring on;
- a failing `anchor` neither stalls the loop nor drops later digests.

**Alternatives considered.**

| Alternative | Why not |
| :--- | :--- |
| The host appends every record to VLX, and the engine keeps no chain | Completions are full prompts plus model text, many per tick. They are draft-tier reasoning, which belongs in the Vault and is shredded, not in the permanent log of record. It would tie the open-source engine to one ledger, and a host could still drop a record before appending it. |
| Sign every record | The engine would hold a key, at a far higher cost. A signed digest of the head already commits to everything before it. |
| A Merkle tree per digest | Single-record proofs in O(log n). It can be added inside the same digest later without changing any entry, and record hashes already allow per-record disclosure. |
| One chain per stream | Loses the proven order across streams, and gives four heads and four values to resume from. |
| RFC 8785 canonical JSON | A second canonical form in one stack, which is how copies drift. VLX's contract keeps one verifier for both chains. |

**What it proves, and what it does not.**
- **It proves no rewrite after anchoring.** Between digests, the unanchored
  tail can still be rewritten; `every` bounds that window.
- **It does not prove the engine was unmodified.** A modified engine can
  produce a consistent chain from the start. Replay (step 4) closes that,
  because re-execution from the seed and the recorded inputs must reproduce
  it.
- **The model's answers are trusted as recorded,** which is the limit of
  treating the model as an oracle.
- **A record the host loses becomes unverifiable:** detectable, not
  preventable.

**Not in this change.**
- Step 4's verify CLI and its replay check.
- Putting an SDK host's acks and escalation answers on the replay tape
  (POLICY_REAFFERENCE P4b), which is replay work rather than anchoring.
- Key management.
- The git and file adapters. A host's adapter is a few lines, as VLX's
  `anchorWillDigest` shows.


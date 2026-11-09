# Record anchoring — tamper-evident decision records

> **Standing:** DESIGNED · 2026-11-09 · built, unreleased — designed 2026-07-08 and settled against the engine 2026-11-09; all four steps landed (the chain, digests, the `anchor()` hook, and `will verify` with replay from the chain); SHIPPED at the next release
>
> **The picture:** `docs/graphs/record-anchoring.svg` — the whole arc in one
> diagram: what reaches the mind and what it does, chained in order; the host keeps
> the chain, a signed digest goes where the operator cannot rewrite it, and anyone
> can verify it or replay the mind from it.
>
> **2026-11-09:** **all four steps are BUILT.** Steps 1–3: `core/record.chain.ts`,
> `core/record.tap.ts`, `stem/tracts/anchor.controller.ts`, and `anchoring` on
> `Will.create` / `Will.wake`. Step 4: `core/record.verify.ts`,
> `stem/tracts/anchor.files.ts`, `stem/replay.chain.ts` and `will verify`.
> A mind whose model answers over a network, with the answers landing at
> varied ticks, replays entry for entry
> (`tests/integration/replay.chain.test.ts`). Open: replay from a stored
> snapshot, and wall-clock safety timeouts (see Step 4 below).

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


---

## Step 4 — verify, and replay from the chain (decided 2026-11-09)

Settled against the engine before any code, read end to end. The finding
that shaped it: a live mind's oracles answer at wall-clock moments, and
*when* an answer reaches the mind decides what the mind does with it. The
chain already records that moment: it is the answer's place in the chain.

### 4a. `will verify`, without replay

```
will verify <records.jsonl> [--digests <digests.jsonl>] [--key <public.pem>] [--from <seq>:<hash>] [--replay]
```

- **Records** are the entries a host kept from `record()`, one JSON object
  per line. **Digests** are `{ digest, signature? }` lines.
- **Checks:**
  - the chain verifies from genesis, or from `--from`, for a chain a woken
    Will continued;
  - every digest names an entry that is in the chain: same `seq`, same
    head hash, and the same Will;
  - with `--key`, every digest carries an Ed25519 signature over
    `canonical(digest)` that the key verifies, encoded in base64.
- **Reports:**
  - the first broken entry by `seq`, with the reason;
  - the unanchored tail, the entries after the last good digest. `every`
    bounds this window.
- **Exit codes:** 0 when everything checks; 1 when something fails; 2 for
  a usage error.
- **The engine ships the host side too:**
  - `fileAnchoring(dir, { every, sign? })` writes exactly the files
    `verify` reads, so the format belongs to the engine and not to each host;
  - `ed25519Signer(privateKeyPem)` signs, and `ed25519Verifier(publicKeyPem)`
    checks.

### 4b. Replay from the chain

Replay re-executes the mind from its starting state, feeding it every input
the chain recorded at the place the chain recorded it. It then compares
what the mind produces, entry by entry. The result is reproduced through the
last entry, or diverged at a `seq` with both records.

**Every input reaches the chain, and only through one door.** Inputs that
were not on it before:

| Input | Was | Now |
| :--- | :--- | :--- |
| SDK and stem `sense` / `senseText` / `senseSignal` | straight into the sense engine, at wall time | a `sense` envelope on the inbound queue, applied at the next tick. `await will.sense()` still resolves when its turn completes |
| A host's effector ack (`confirmEffectorExecution`) | applied directly | an `ack` result envelope. `observation` included: the envelope now carries the whole `EffectorAck` |
| A host's delivery ack (`confirmMessageDelivery`) | applied directly | an `ack` delivery envelope |
| An escalation answer (`resolveEscalation`) | queued, unrecorded | an `escalation` envelope (POLICY_REAFFERENCE P4b's open item) |
| `injectEvent` | written straight into state | an `event` envelope |
| The wake signal on resume | sensed directly, with the offline time read from the wall | a `sense` envelope |
| LLM answers, failures included | chained on success only | chained at arrival, success or failure |
| Semantic recall | a second oracle, unrecorded | a `recall` entry at arrival: the results, or the timeout |
| An async policy verdict | chained at arrival | unchanged; replay now delivers it there |
| The clock | wall time read continuously | one `clock` entry at the start of every step, carrying the sim time the step runs at. Between ticks the clock now holds still |
| Pause and resume | not chained | `chain` entries `{ lifecycle: 'pause' }` / `{ lifecycle: 'resume' }` |

The inbound record's `tick` moves to the simulation tick, the axis every
other entry is on.

**What a host sees change:** a host input takes effect at the next tick
rather than the moment it is called — at most one tick interval later. This
is the transport's rule already, so the two doors stop differing. Applied
between ticks, it was already first visible at the next step.

**Genesis commits to the starting state.** The `chain` entry now carries:
- `config`: the `WillConfig` in its JSON form, without the anchoring hooks,
  the transport or storage adapters, and without any field whose name says it
  is a secret (`apiKey`, `token`, `secret`, `password`). That is why the 2026-07 design
  narrowed it to the seed.
- `env`: the `WILL_*` settings the mind reads at assembly, filtered the same way;
- `recall`: whether the mind has semantic memory;
- `restored`: when a stored snapshot was restored, its tick, entity count and
  hash.

A PMA loaded by `Will.wake` is chained whole as a `chain` entry
`{ loaded: 'pma', pma }`. It is the portable artifact, and an input like
any other.

**When an answer reaches the mind.** Each answer's place in the original
chain decides when the replay hands it over:
- **Between ticks**: after the step's `tick` session entry and before the
  next `clock` entry. This is the normal case, since an answer is a network
  callback and arrives while the loop sleeps. The replay hands it over at the
  same boundary, in chain order, once every entry before it has been
  reproduced. It then lets that answer's work settle before the next.
- **Inside a step**: between a `clock` entry and that step's `tick` entry.
  This happens only when an engine awaits an oracle inside `react()`. The
  orchestrator already flags that as a defect. The replay hands it over as
  soon as everything before it has been reproduced.

The sources the replay registers are the existing seams. The completion,
inbound and verdict sources now return a promise the schedule settles, and a
recall source is added. In a replay, each capture site chains the recorded
input **verbatim**, so input entries reproduce hash for hash.

**What is compared.** The replay's own chain grows beside the original:
- an input entry must match exactly;
- an output entry must match its stream, its tick and its record, compared
  without its wall-clock fields: `wallTime`, `startedAt`, `resumedAt`,
  `durationMs`. The list lives in one place and every name on it is tested;
- a shredded output is compared by position only, and the report says how
  many were.

The first difference is the divergence. A replay that produces nothing more
when the original continues has diverged too.

**What replay will not do, and says so:**
- **Begin from a stored snapshot.** The chain commits to its hash, not its
  contents, and a long-lived mind's snapshot is its whole memory. Replay
  begins at a genesis that is fresh or woken from a PMA, and refuses
  otherwise, naming the tick.
- **Reproduce wall-clock safety timeouts.** These are audition's 60-second
  turn and outreach timeouts, and a model call's own timeout. A timeout that
  fired is reported as the divergence it causes. A failed model call is
  chained, so its failure reproduces.
- **Call a model, an embedder or an arbiter.** Every answer comes from the
  chain; a request with no recorded answer is a divergence.

**Alternatives considered.**

| Alternative | Why not |
| :--- | :--- |
| Quantize every answer to the next tick in live runs | Deadlocks any engine that awaits an oracle inside a step, and adds a tick of latency to every call. The chain's order already says where an answer arrived. |
| Record each answer's landing tick at every landing point (the inbox, `AsyncEngine`, the summariser, motor) | Four seams that each have to be found and kept, against one per oracle. A seam missed later would diverge silently. |
| Replay to a final state and compare only that | It cannot say where a run went wrong, and the state is not on the chain. |
| Store the starting snapshot in the chain | Megabytes at every restart, for a mind's whole memory. A PMA is the portable start and is chained whole. |

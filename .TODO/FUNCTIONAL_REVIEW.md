# FUNCTIONAL_REVIEW — Behavioural / correctness review (`will` codebase)

> **Standing:** OBSERVED · 2026-05-29 · found by tracing runtime logic — the tick loop, LLM I/O, optimistic concurrency, serialize→snapshot→replay, HNSW — rather than by reading structure

> Companion to `FIX_TODO.md` (tactical) and `REORIENT_TODO.md` (architectural). Those two reviewed
> *structure, performance, and tooling*. This file is the result of **tracing the actual runtime logic**
> — following data through the tick loop, the LLM I/O path, the optimistic-concurrency machinery, the
> serialize→snapshot→replay round-trip, the HNSW index, and a sample of the faculty engines — to find
> places where the code **does the wrong thing at runtime**, not just where it's shaped awkwardly.
> Reviewed 2026-05-29. `file:line` as read at review time. Severity: **C** critical, **H** high, **M** medium, **L** low.

---

## The headline: the three "differentiator" subsystems don't deliver their promise

`will`'s pitch rests on three guarantees — *deterministic replay*, *optimistic-concurrency reasoning*,
and *semantic memory*. Tracing each one end-to-end, **all three are functionally broken or hollow today**,
independently of the tactical bugs already filed. This is the most important conclusion of the review.

---

## FN1 — Optimistic-concurrency conflict detection is both wrong AND dead code  **[C]**
`src/core/conflict.detector.ts` (`detect`)
- The conflict check compares `entity.updatedAt` (epoch milliseconds, stamped by `StateManager.setEntity`)
  against `footprint.tickObserved` (a **tick integer**). `1.7e12 > 42` is always true, so *every* entity in
  a footprint is flagged "changed". The comparison is a unit mismatch — ms vs ticks — so the detector can
  never report "no conflict" correctly.
- It doesn't matter in practice, because **both** `AsyncEngine` subclasses construct with
  `defaultStrategy: 'FORCE'` (executive.engine `engine.ts:167-168`), and the FORCE path in
  `async.engine.ts._collectCompleted` bypasses `detect()` entirely — it always calls `onReasoningComplete`.
  So the REJECT / MERGE / rerun logic, the `ReasoningFootprint`, and the whole detector are **dead code**.
- Net effect: the "re-validate background reasoning against current state" feature — described in
  REORIENT as a genuine strength — is not actually running. It's a well-designed mechanism that nothing
  exercises, sitting on top of a comparison that couldn't work if it did. Fix the unit mismatch *and*
  decide whether any engine should ever run non-FORCE; otherwise delete the subsystem honestly.

## FN2 — `ReplayRecorder.flush()` throws recorded data away  **[H, data loss]**
`src/core/replay.ts:128-133`
```ts
async flush(): Promise<void> {
  if( this._records.length === 0 ) return
  console.log(`[Replay] Flushed ${this._records.length} records …`)
  this._records = []            // ← discarded, never written to storage
}
```
- `flush()` logs a count and clears the buffer **without persisting anything**. It is called automatically
  when the buffer hits `bufferSize` (default 1000) (`:117`, `:125`) and on every `flushIntervalMs` timer
  tick (`:103-104`), and from `close()` (`:152`). Only `save(path)` actually writes.
- Consequence: any session that records more than `bufferSize` events (i.e. any non-trivial run) **silently
  loses all replay history** as the buffer rolls over. The data you'd need to replay is gone before
  `save()` is ever called. This alone makes replay unusable for real runs.

## FN3 — "Replay" is event-playback, not deterministic re-execution  **[H, capability gap]**
`src/core/replay.ts` (`DefaultReplaySession`, `ReplayManager.compare`)
- `DefaultReplaySession.play()` re-emits the recorded `SimulationEvent`s to registered handlers on a
  `setInterval(16/speed)` timer (`:187-197`, `:308-317`). It **never re-runs the engines or the tick loop**.
  `compare()` diffs two recorded event logs (`:375-457`). So "frame-accurate deterministic replay" is, in
  reality, *playing back a recording like a video* — useful for visualization, but it cannot reproduce a run
  from seed+inputs, and cannot prove determinism.
- `randomSeed` is stored in metadata (`:98`) but nothing ever reads it back to reseed a re-execution
  (because there is no re-execution).
- **LLM completions are never recorded** anywhere in the replay path. Even if re-execution existed, the
  executive's decisions (the most behaviour-defining outputs) couldn't be reproduced. This is the concrete
  evidence behind REORIENT R2: replay can only ever mean "replay of recorded events", not "re-run the mind".

## FN4 — HNSW graph search traverses the wrong node's neighbours  **[H, recall]**
`src/memory/vector.index.ts:268`
```ts
private _searchLayer( entry, query, level, ef ){
  …
  while( candidates.length > 0 ){
    …
    const neighbors = entry.connections.get( level ) ?? new Set()   // ← always `entry`, never the popped node
```
- Inside the greedy search loop, the code expands `entry.connections` — the **fixed entry node** passed into
  the function — instead of the connections of the candidate currently being popped (`best`). The traversal
  therefore never hops beyond the entry node's immediate neighbourhood; it's a 1-hop scan dressed up as a
  graph walk. Recall degrades to "whatever happens to be adjacent to the entry point", and the multi-layer
  structure buys nothing. This is a real ANN-correctness bug, not a tuning issue.

## FN5 — HNSW level assignment is unseeded — the class's own determinism claim is false  **[H]**
`src/memory/vector.index.ts:236-242` vs docstring `:56`
- The header comment says *"Deterministic for given insertion order (important for replay)."* The very next
  method, `_randomLevel()`, uses raw `Math.random()`. Two inserts of the same records in the same order
  produce different graph topologies and different search results. The documented guarantee is
  contradicted by the implementation one screen below it. (Same root cause as FIX F2 / REORIENT R6.)

## FN6 — HNSW never prunes neighbour lists; entry-point reselection ignores level  **[M]**
`src/memory/vector.index.ts:112-115, 169-170`
- On insert, neighbours get `neighbor.connections.get(l).add(record.id)` with **no shrink back to `M`**.
  Node degree grows unbounded over time → memory bloat and ever-slower `_searchLayer`. Canonical HNSW prunes
  each touched neighbour back to `Mmax`.
- On delete of the entry point, the replacement is `this._nodes.keys().next().value` — an arbitrary node that
  may live only at level 0 while `_maxLevel` stays high. The top-down descent then starts from a node with no
  high-level connections and returns just itself, compounding FN4.

## FN7 — `ForgettingCurve` pruning is a no-op → episodic memory grows without bound  **[H]**
`src/cognition/engines/faculties/forgetting.curve.ts:152-163`
```ts
if( episode.activationStrength < this._pruningThreshold && prunedCount < this._maxPrunePerTick ){
  // Mark for pruning — the consolidator manages the store
  prunedCount++              // ← increments a counter; nothing is ever removed
}
…
commands.metrics!.push([ 'memory.pruned_this_tick', prunedCount ])   // ← reports prunes that didn't happen
```
- The branch that's supposed to evict decayed memories only increments a local counter — it never calls the
  consolidator to delete anything. Episodes decay toward zero activation and then **stay in the store
  forever**. The `memory.pruned_this_tick` metric reports a non-zero count for prunes that never occurred, so
  the lie is also observable in telemetry. This is the load-bearing memory-management loop and it does nothing.

## FN8 — Engines mutate live shared state directly inside `react()`, bypassing the command pipeline  **[H, determinism]**
`src/cognition/engines/faculties/forgetting.curve.ts:146-149` (representative)
- `getAllEpisodes()` returns the consolidator's live objects, and `react()` writes
  `episode.activationStrength = …` straight onto them. The decay is **not** expressed as a `StateCommand` or
  event — it's a direct mutation of shared state during the read-phase of the tick. Because `snapshot()` is
  shallow (FIX F1), this mutates the very objects other engines are reading this tick, and none of it is
  recorded for replay. The executive's `buildStateCommands` dual-write (manager side-effects + entity
  commands) is the same anti-pattern from the other direction. This is the mechanism by which "double-buffer
  commit" and "deterministic replay" are silently violated in normal operation, not just in theory.

## FN9 — Engine-internal mutable state is never snapshotted → restore/replay can't reproduce it  **[H, determinism]**
e.g. `energy.regulator.ts` (`_activityMultiplier`, `_cognitiveLoad`, `_salience`, `_model`), and every faculty
that holds a `SalienceComputer` / `GenerativeModel`.
- Each engine carries private accumulating state: activity multipliers, salience precision trackers,
  generative-model prediction baselines, etc. `snapshot()` on most engines returns `{}` (e.g.
  `forgetting.curve.ts:106`) or a single field (`energy.regulator.ts:102-106`). The serialized
  `SimulationState` (`serialization.ts`) only captures entities + metrics — **none of this engine-local
  state**. After a snapshot restore (or any attempt at replay), every engine resumes with freshly-zeroed
  internal state, so behaviour diverges immediately. Determinism requires *all* mutable state to be either in
  the state store or reconstructable; today a large fraction of it is neither.

## FN10 — Executive parser corrupts valid JSON before parsing optional blocks  **[M]**
`src/cognition/engines/faculties/executive.engine/parser.ts:152-165` (`parseJsonBlock`)
- Each tagged block is unconditionally run through
  `block.replace(/\\"/g,'"').replace(/\\n/g,'\n').replace(/\\\\/g,'\\')` before `JSON.parse`. When the LLM
  emits *correctly-escaped* JSON (the common case), this un-escaping mangles it, `JSON.parse` throws, and the
  `catch` silently returns `null`. The result: `PLANS`, `BELIEFS`, `GOALS_*`, `NARRATIVE`, `IDENTITY`,
  `EFFECTORS`, `SELF_OBS` are **dropped intermittently** depending on whether the content happened to contain
  escapable characters — a non-deterministic, content-dependent data loss in the highest-value output path.
  All eight blocks swallow their own parse errors, so this fails invisibly.

## FN11 — `buildStateCommands` can diverge from manager side-effects under tick abort  **[M]**
`src/cognition/engines/faculties/executive.engine/commands.ts`
- `buildStateCommands` is not pure: it performs manager writes (outbox, effector registration, etc.) *and*
  returns entity/metric commands describing the same changes. These execute at different times — the manager
  writes happen during `react()`, the commands during commit. If a pre-commit validator aborts the tick
  (`orchestrator.ts:469-484`), the manager side-effects have already landed while the entity commands are
  discarded → state and manager drift out of sync, with no compensation.

## FN12 — Decision/belief IDs are minted from `Date.now()` + `Math.random()`  **[M, determinism]**
`src/cognition/engines/faculties/executive.engine/commands.ts` (e.g. `belief-executive-${Date.now()}-${Math.random()…}`)
- Even with FN2/FN3 fixed, entity IDs derived from wall-clock and `Math.random` guarantee that two runs of
  the same seed+inputs produce different entity graphs. IDs on the deterministic path must come from
  `context.prng` + the sim clock (REORIENT R2).

## FN13 — SnapshotManager delta baseline never advances; ring-buffer eviction unanchors deltas  **[M, data-integrity]**
`src/core/snapshot.manager.ts:106-127`
- `_lastFullState` is only assigned when `delta` is falsy (`:127`). After the first full snapshot, **every**
  subsequent snapshot computes its delta against that one tick-0 baseline forever, never advancing. Deltas
  therefore grow without bound and, once the baseline entry is evicted by the `maxInMemorySnapshots` ring
  buffer (`:123-124`), the remaining delta-only entries reference a base that no longer exists.
- It happens to not corrupt *restore* today only because each entry also stores the **full** serialized
  `state` (`:114-116`), making the delta redundant — i.e. the delta feature is simultaneously broken and
  unused, while paying double storage + an extra serialize/deserialize cycle per snapshot.

## FN14 — DeltaEncoder fabricates `time` on decode  **[L]**
`src/core/serialization.ts:351` — `time: base.time + (currentTick - baseTick) * 16` hardcodes 16 ms/tick,
contradicting the configurable `tickIntervalMs` (default `0`). Reconstructed timestamps are invented, not the
recorded values.

## FN15 — JSON state serialization silently drops `Map`/`Set`/`Date` in entity components; checksum can't catch it  **[M, latent]**
`src/core/serialization.ts:119-150, 236-265`
- Entity `metadata`/`components` are typed `Record<string, unknown>` and serialized via `JSON.stringify`. Any
  `Map`, `Set`, `Date`, class instance, or `undefined` stored there is silently flattened/lost on round-trip.
  Whether this bites depends on what faculties stash in components — but nothing prevents it, and the
  `_computeChecksum` deliberately **excludes** metadata/components (`:232-234`), so such corruption passes the
  integrity check undetected. (The top-level entities/metrics Maps themselves round-trip fine — they're
  explicitly converted to arrays.)

## FN16 — Embedder `fetch` has no timeout  **[L]** — `src/memory/vector.embedder.ts:53-71`
Same hung-connection exposure as FIX F4, on the embedding path; `embedBatch` also fans out with `Promise.all`
and no concurrency gate. `data.data[0]!.embedding` will throw on an empty response.

---

## Cross-cutting theme
Almost every finding above is one symptom of a single root cause: **mutable state lives in too many places that
the event-sourcing core doesn't see** — engine-private fields (FN8, FN9), manager side-effects (FN11),
wall-clock/`Math.random` IDs and RNG (FN5, FN12), and a snapshot that's shallow by construction (FIX F1). The
core advertises determinism and replay; the cognition layer was written as ordinary stateful objects. The two
halves were never reconciled. REORIENT R2 + R3 + R4 are the structural fixes; FN1–FN9 are where the gap is
actually drawing blood today.

The faculty *math* itself, where I sampled it (energy regulator's thresholds/hysteresis, the forgetting-rate
formula, cosine similarity), is sound and thoughtfully bounded — the problems are in plumbing and state
discipline, not the cognitive models.

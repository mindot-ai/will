# Audition conversation-reply determinism + reliability gap

**Status:** ✅ RESOLVED (2026-07-08). Root cause found, guarded at the engine
chokepoint, and both done-criteria are now pinned by CI tests.
**History:** found 2026-07-05 while building the SDK facade (examples/effectors.ts).

## Root cause (measured, not the suspected mechanism)

The suspected salience/attention race was wrong. The flake was **environment
bleed**: bun auto-loads the dev `.env`, which carried `WILL_SEMANTIC_RECALL=true`
+ `WILL_EMBEDDING_MODEL=google/…` + a live Google key — so every "mock" Will was
doing **real network embedding calls inside `buildExecutiveContext`** on the
facet reasoning path. Wall-clock embed latency (~600–800 ms per context build)
then jittered the LLM issue tick, which jittered everything downstream:

- reply tick varied run-to-run (measured 123–169 under seed 7);
- reply CONTENT varied — the mock picks `REPLY_CYCLES[tick % 4]`, so tick
  jitter selected different canned replies (4 distinct texts across 12 runs);
- pre-#27, in-flight facets could be reaped mid-chain → the original
  "no reply at all" failures. (#27 "never reap a busy facet" fixed the loss.)

With recall actually off: **8/8 fresh-process runs byte-identical** — reply at
`ingestTick + 1`, same content, every run. The engine's conversation path was
already deterministic (report → per-tick pump → CompletionInbox landing); the
tick-quantization layers were never the problem on this path.

## The fix

1. **Engine guard (`_resolveVectorMemory`, stem/mind.ts):** `testMode` refuses
   the env-driven NETWORK embedder (logs and runs without vector memory).
   Explicit adapters and `WILL_VECTOR_MEMORY=mock` stay honored. This kills the
   `.env`-bleed class at the single chokepoint — it had bitten three times
   (replay layer-3 masking, the soak test, this flake).
2. **Conversation replay test** (`tests/integration/replay.conversation.test.ts`)
   — the R2-d peer for the audition path: scripted `ingest` at a fixed tick,
   record → re-feed, asserts the reply (content + target + outbox tick) and the
   FULL state snapshot replay byte-identically. Done-criterion (a).
3. **Reliability test** (`tests/integration/audition.reply.reliability.test.ts`)
   — greeting, instruction phrasing, and with a registered effector each reply
   within a bounded tick budget. Deliberately does NOT override recall env, so
   it doubles as the end-to-end sentinel for the guard. Done-criterion (b).

## Residual notes

- Under a live LLM + live embedder, tick-exact determinism is not a goal —
  replay-grade audit uses the record/re-feed seam (completion recorder), which
  the conversation test now covers.
- The mock's reply-content selection (`tick % 4`) makes content a visible
  canary for tick jitter — useful; left as-is.

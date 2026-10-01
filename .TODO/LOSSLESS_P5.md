# LOSSLESS P5 — every call fits its window, and nothing leaves a call silently

> **Standing:** DESIGNED · 2026-10-01 · traced from prompt.factory, context, facet, the MCP and channel bridges and the replay contract, and measured on 242 of Lora's master calls; 6 decisions open for the owner

> The last phase of [[LOSSLESS]]. P0–P4 made what the mind takes in, thinks, says and
> keeps whole. This phase is about what a **single LLM call** is shown. That view
> stays bounded, but nothing leaves it silently. Everything out of view is
> **ranked, counted, and reachable whole**.

---

## Where a call stands today

What a call is shown has three parts. The **system prompt** (identity, guidelines,
output schema) is about 11.8k characters, roughly 3k tokens, and is cache-stable.
The **user message** is about twenty sections, built in `PromptFactory.buildUserMessage`
from `buildExecutiveContext`. Last comes the **output format**. Master and facets use
the same builder; a facet sees the sections its creator scopes (`DEFAULT_FACET_AWARENESS`
includes percepts, ruminations and memories).

Measured on the one live mind (lora-c4cq81, 1,917 calls, Aug 11–31):

- the largest input was 13,401 tokens (p99 7,462);
- the largest output was 3,171 tokens against an 8,096 ceiling;
- across 242 master calls with a prompt on disk, characters per token ran 3.72–4.42 (median 3.85).

**The engine has no notion of a context window.** Today that is safe only because
nothing large ever arrived.

## The risk P2 opened (P5a closes it)

P2 made what an act brings back whole, and it was right to: the 65 lookups came from
a cut. But that also means the whole of it now reaches every prompt:

- an MCP tool's output becomes an `observation` (`surface/mcp/effectors.ts`), then a
  reafferent percept's `data`, then a working-memory item's `content.data`;
- `perceptLine` and `ruminationLine` render that data whole. While the percept is
  still live (2 ticks) **it renders twice**, once under Percepts and once under
  Ruminations. For about the next 9 ticks it renders once, in **every** master and
  facet prompt.

One raw 30-PR listing is about **135k tokens**. GLM-5.2's default window is about 203k.
One read fits only just; two reads, or one read during its first two ticks,
exceed the window, the provider refuses the call, and the executive goes dark. **Lora's
second self holds six GitHub read tools and has not booted yet.** P5a should land
before her first boot (decision D6).

There are two quieter forms of the same gap:

- A remembered observation is recalled as its **label**. `_extractEpisodeContent`
  reads `summary`, and the data never renders. Once the item leaves working memory,
  she knows she read `list_pull_requests` but not what it said. The data is whole in
  the episode store, but nothing in view reaches it.
- An attachment is **inlined into the message text** (`surface/channels/types.ts`
  `renderAttachments`). It is capped at 24,000 characters and 4 files, with a 256 KB
  fetch limit. With the caps removed, a 2 MB document would ride everywhere the
  message text goes: the conversation focus, the thread digest, the "they answered"
  lines, and conversation memory.

---

## The design

### Part 1 — a window the engine knows

- **Declared by the host, per model, beside prices.** `providers.<p>.contextWindows: { [modelId]: tokens }`
  is keyed and matched exactly like `prices` (`normalizeModelKey`).
  `llm.contextWindow` covers the single-provider path.
- **Unlike a price, a window changes what the mind sees.** It is therefore an input
  to the prompt. That is fine for replay, which matches prompts byte for byte
  (`RecordedCompletionSource`), because the window is fixed configuration for the
  run and the view is a pure function of state and config. A replay must run with
  the same windows, so the run's recorded config carries them.
- **The window is the routed model's.** The router is a pure function of the call's
  attribution (`LLMCallMeta`), so `LLMDirector.windowFor( meta )` can resolve the
  route the call *will* take before the prompt is built. Today that resolution
  happens inside the call.
- **Estimating tokens:** deterministic, `ceil( utf8Bytes / 3 )`. Prose measured
  3.72–4.42 characters per token, while JSON, ids and code tokenize more densely,
  so 3 is the margin. The estimate never uses the provider's reported count, which
  arrives after the call and would make a prompt depend on something a replay
  cannot reproduce.
- **The budget for the user message** is the window minus `maxOutputTokens`, minus the estimated system prompt, minus a 5% reserve.
- **When no window is declared:** a conservative default (D2). "Today's behaviour"
  is no fallback, because today's behaviour with whole data is the overflow.

### Part 2 — an item larger than a page is a document, not a line

One rule applies to any single item rendered in any section: an observation's data, an
attachment, a message, a memory's content, a belief.

- **At or under a page, it renders whole.** A page is min(8k tokens, budget / 8) (D3).
- **Over a page, it renders as a header and its first page:**
  ```
  - [observation] list_pull_requests (salience: 0.80) — 412 KB ≈ 135k tokens, 17 pages · doc:ep-2210-0
    page 1 of 17 (items 1–4 of 30):
    [...]
    → the rest is whole in memory; {"recall": [{"doc": "ep-2210-0", "page": 2}]}
  ```
- **Page boundaries are deterministic.** A JSON array pages by element, other JSON by
  its pretty-printed lines, and text by lines. The pages concatenate back to the
  whole: **no byte is dropped, only placed on another page.**
- **A document is named once.** Its handle survives the percept's sweep: `doc:<id>`
  resolves through the working-memory item while it lives and the episode after
  that (`episode.sourceId` is `wm-percept-<percept>`). One handle reaches it for as
  long as she remembers it.
- **One item, one render per prompt.** A percept that working memory also holds
  renders its data under Ruminations, where it lives longer. Under Percepts it
  shows only the label and "(held in mind, below)".
- **No summaries.** An LLM summary of a long item would hand the mind someone else's
  conclusion, which SIGNAL_BOUNDARY P2 rules out. Paging hands it the evidence, a
  page at a time.

### Part 3 — every count is honest, and she can reach past it

Each section that shows N of more renders its ranked top N, **states exactly how many
are left**, and names the rest compactly where that is cheap, so that every item is
nameable.

**Recall** — decision D1:

**(a) Recommended: a request in her output.** A `[RECALL]` block works like
`[KNOWN_ENTITIES]`:
```
[RECALL]
{"recall": [{"doc": "ep-2210-0", "page": 2},
            {"section": "beliefs", "query": "payments migration"},
            {"section": "people", "page": 2},
            {"memory": "episodic-1200-0"}]}
[/RECALL]
```
The request is honoured on the **same seat's next call** (the master's next cycle, or
that facet's next report) under `## Brought Back (I asked for these)`. Items render
whole there, with Part 2 still applying. A miss is stated ("I hold no record of
`episodic-99-0`"). A recalled episode is `markRetrieved`, so recall strengthens
retention as it already does. The request rides the recorded output, so a replay
re-derives it.

**(b) The alternative: an innate `recall` act** through the agency field. This is
what the LOSSLESS sketch said, and it is consistent with `inspect`'s "one act, one
answer, one percept". But reaching her own memory would then compete with acting:

- it would be subject to energy, satiation and habit, and could lose;
- its answer would ride working memory (7 chunks, decaying) and render twice;
- reafference would learn "a skill of remembering" from it.

Remembering what she already holds is attention, not an act on the world, and the
executive's other cognitive outputs (beliefs, goals, people) are not acts either.

| Section | Today | Ranked by | Count + recall |
|---|---|---|---|
| Abilities | first 8 **by iteration order** (`context.ts:379`) — the Lora unban flip-flop | what the competition weighs: expected reward, habit, plan bias | names of all the rest; `{"section":"abilities"}` shows their meanings |
| Beliefs | 30, ≤8 per category, "[+N omitted]" | unchanged (dedup, confidence × recency × goal match) | `query` / `page` |
| People | 6 by recency (`context.ts:502`) | recency, then closeness | names of the rest; `page` |
| Percepts | top 10 by salience (`context.ts:663`, `prompt.factory.ts:816`) | salience | `page` |
| Memories | 8, then a 1,200-character budget | semantic relevance, then recency | whole lines; `query` / `page` / `memory` |
| Self-observations | 6, with a count (#183) | newest | `page` |
| Spoken turns · action records · traits | 6 · 6 · 6 | newest / salience | `page` |
| Thread digest · facet master-sync · facet reasoning | 5 · 5 · 10 | newest | `page` |

The default counts stay. They are attention and cost, not the window (D5). Under a
small window they shrink further, still counted.

`ACTION_RECORD_KEEP` deletes action records past six **from state**, by design ("a
working record, not a memory system"). Before calling that MIND, P5c checks whether
every act's outcome is remembered some other way.

### Part 4 — single-item text cuts in VIEW are removed

Each of these becomes whole, and Part 2 handles anything that turns out to be oversize:

- `surface/mcp/effectors.ts` `MEANING_CAP` 300. It hides the required args of GitHub
  tools, so she cannot supply them and the act fails;
- `prompt.factory.ts` `MEMORY_CONTINUITY_CAP` 1,200, which labels its cut `[...summarized]`;
- `RECALL_CHAR_BUDGET` 1,200;
- `context.ts` `extractSummary` 120 / 200;
- the plan's expected outcome, 80.

### Part 5 — what she read is recallable by meaning

An observation episode is embedded by its label of at most 100 characters
(`vector.content.ts`). Its data is now embedded in page-sized chunks
(`<episodeId>#<page>`), so semantic recall finds **the page that answers** and
Memories renders that page through Part 2. Deleting an episode removes its chunk
vectors (the P3a in-flight cancel extends to them). Cost: Jina, about $0.02 per 1M
tokens. Re-reading the same 135k-token listing every day comes to well under a cent.

### Attachments are their own items (moved from P2)

The bridge delivers each file **whole as its own item** (the heard percept's
`data.attachments`). The message text carries only a reference:
`[Ada shared payments-spec.md (412 KB) — doc:…]`. The 24,000-character, 4-file and
256 KB caps are removed. The fetch keeps its CDN allowlist, which is security, not
size, plus one declared ceiling above which a file is named and not read, and she
is told why (D4).

### The safety net

After the view is built, if the user message's estimate still exceeds the budget:

1. ranked sections shrink from the lowest priority, with counts kept honest;
2. oversize items drop to their header only (handle and size).

The call never fails for size. Each trim writes a `view.trimmed` record with what
moved out, so the operator's record shows it. If even the fixed parts exceed the
window, that is a configuration error, raised loudly at assembly.

---

## Order of work, one PR each

| | What | Why first |
|---|---|---|
| **P5a** | Window, estimate, budget, Part 2 paging, one render per item, `[RECALL]` for `doc` pages, the safety net | Closes the overflow P2 opened, before Lora's first GitHub boot |
| **P5b** | Part 4: text cuts removed, `MEANING_CAP` first | Her GitHub tools' required args |
| **P5c** | Part 3: honest counts, ranked abilities, `[RECALL]` for sections, queries and memories | The silent drops |
| **P5d** | Attachments as items | Depends on P5a's paging |
| **P5e** | Part 5: chunked embedding of what she read | Depends on P5a's pages |

The tests follow the epoch's rule: each test asserts on the **rendered prompt or
stored state**, and every assertion is checked by reintroducing the bug it guards
against. The P5a acceptance test is a 135k-token observation on a 203k window. The
prompt must stay under budget, every page must be reachable through `[RECALL]`, the
pages must concatenate back to the data byte for byte, and a recorded run must
replay byte-identical.

## Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| **D1** | How she reaches past the view | (a) a `[RECALL]` request honoured on the same seat's next call, not an innate act |
| **D2** | No window declared | A conservative default of 128k tokens, not "today's behaviour" |
| **D3** | Page size | min(8k tokens, budget / 8). A 135k-token read then takes 17 cycles to read through whole, and she chooses which pages she needs |
| **D4** | Attachment fetch ceiling | 20 MB: above it the file is named, not read, and she is told why |
| **D5** | Default view counts | Keep today's numbers as attention defaults, made honest; they do not scale with the window |
| **D6** | Lora's first boot | Hold it until P5a lands, which is the next PR either way |

## Not this phase

- No tokenizer dependency. The estimate is deliberately conservative arithmetic.
- No LLM summaries of long items, and no truncation anywhere.
- The mind's own limits stay as designed (§ MIND in [[LOSSLESS]]).

## Related

[[LOSSLESS]] · [[SIGNAL_BOUNDARY]] (P2: the host sends data, the mind makes the
meaning) · [[FIELD_NOTES]] (the 65 lookups) · [[MODEL_ROUTING]] (the router a window
resolves through)

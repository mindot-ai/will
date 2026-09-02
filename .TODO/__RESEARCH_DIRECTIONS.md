# Experimental Research Directions

> **Standing:** SPECULATIVE · 2026-08-03 · a synthesis of established ideas (case-based reasoning, speculative decoding, mixture-of-experts) applied to structured agent cognition. The fast-path/slow-path architecture is proven; this application of it is not, and no published system has demonstrated it

## Part I: Research Sketch — The DeliberationCache Formula

> **Honest framing:** This formula is a synthesis of established ideas (case-based reasoning, speculative decoding, mixture-of-experts) applied to a novel domain: structured agent cognition. The fast-path/slow-path architecture is proven. Applying it to *multi-field structured reasoning* (plans, beliefs, goals, introspection) is experimental. No published system has demonstrated this for agent cognition.

### 2.1 Core Architecture

The ExecutiveEngine (and its subordinate DeliberationEngine) produces structured output:

```
O = (A, B, P, N, I, G)
    A = actions
    B = beliefs
    P = plans
    N = narrative
    I = introspection
    G = goals
```

At each executive tick, the system chooses:

```
O_t = LLM(S_t)        if ρ_t < θ  (slow path — teacher)
O_t = Cache(S_t)      if ρ_t ≥ θ  (fast path — learned interpolation)
```

where:
- `S_t` = the full simulation state snapshot (frozen, read-only)
- `ρ_t` = internal confidence of the cache for this state
- `θ` = confidence threshold (annealed over time)

### 2.2 Confidence Computation

```
ρ_t = max_{i ∈ N_t} [ κ_i · sim(φ(S_t), h_i) ]
```

| Symbol | Meaning |
|--------|---------|
| `N_t` | k-nearest neighbors in the pattern cache (k=5) |
| `h_i` | Stored state fingerprint for pattern i |
| `κ_i` | Competence score of pattern i (0–1, learned from reafference) |
| `sim()` | Cosine similarity or Euclidean similarity on the fingerprint vector |
| `φ(S_t)` | Cognitive fingerprint — see §2.4 |

The `max` rather than `mean` is intentional: we trust the cache only when there is at least one *strongly similar, highly competent* precedent. A diffuse cloud of weak matches should not trigger a cache hit.

### 2.3 Cache Composition (The Hard Part)

When `ρ_t ≥ θ`, the cache must synthesize a valid `O_t` from past examples. This is where standard retrieval-augmented generation breaks down — we are not interpolating text, we are interpolating *structured schemas*.

#### Weighted interpolation:

```
O_t = ⨁_{i ∈ N_t} w_i · O_i

w_i = exp( sim(φ(S_t), h_i) / τ ) / Σ_j exp( sim(φ(S_t), h_j) / τ )
```

`τ` = temperature (start at 0.5, tune via cross-validation on behavioral probes)

#### The compositional operator `⨁` by field type:

| Field | Operation | Rationale |
|-------|-----------|-----------|
| **Numeric** (confidence, priority, salience) | Weighted mean: `o = Σ w_i · o_i` | Standard, safe |
| **Categorical** (action type, goal status) | Weighted vote: `o = argmax_v Σ_{o_i=v} w_i` | Prevents invalid blended categories |
| **Structured** (plan steps, belief tuples) | **Slot fusion**: invariant skeleton from highest-w_i match; variable slots interpolated across matches | Plans have structure; only parameters vary |
| **Text** (narrative, introspection, explanations) | Verbatim from `argmax_i w_i` OR keep LLM for text | Text interpolation produces gibberish; don't try |

**Critical insight:** Do NOT attempt to interpolate text fields. The cache should either:
- Skip text generation entirely (emit empty narrative/introspection), or
- Fall back to a tiny local model (1–3B parameters) for text, or
- Keep the LLM for text while caching the structured decision blocks

### 2.4 Cognitive Fingerprint `φ(S)`

Do NOT embed the raw prompt text. Extract a fixed-dimension scalar vector from the frozen simulation state:

```
φ(S) = [ E, Ψ, δ,           // physiology (3D)
         V, A, D,           // PAD affect (3D)
         g_1..g_k,          // goal priorities (k ≤ 10)
         p_1..p_m,          // top percept saliences (m ≤ 5)
         b_1..b_n ]         // top belief confidences (n ≤ 10)
```

Total: ~30–50 dimensions. All values are already computed by existing engines every tick. No neural network needed for Phase 1.

**Why this works:** The LLM's reasoning is heavily conditioned on these exact scalars (they appear in the prompt's `## Current State` block). Two states with similar fingerprints received similar prompts and should elicit similar reasoning.

### 2.5 Learning Rule

When the slow path (LLM) is invoked:

**Store:**
```
M ← M ∪ { (φ(S_t), LLM(S_t), κ_0 = 0.5, ν = 1) }
```

**Update neighbors:**
```
κ_i ← κ_i + η · (r_t − κ_i) · w_i
```

where:
- `η` = learning rate (0.1)
- `r_t` = outcome reward from reafference
- `w_i` = similarity weight of neighbor i

**Outcome reward:**
```
r_t = (1/3) · [ 1_{action succeeded} + (1 − stress_delta) + goal_progress_delta ]
```

When the fast path (cache) is used:
```
κ_{i*} ← κ_{i*} + η · (r_t − κ_{i*})
```
where `i*` = the winning pattern (highest `κ_i · sim`)

### 2.6 Consolidation: From Episodic Cache to Procedural Skill

Every N ticks (or when |M| > threshold):

```
For each cluster C where |C| ≥ 10 and mean intra-similarity > 0.85:
    1. Extract invariant structure: which fields are constant across C?
    2. Create skill template: "When [state signature], produce [invariant output]"
    3. Register as composite schema in SchemaRepertoire
    4. Remove redundant episodic patterns in C
```

This feeds directly into Will's existing `competence.codec.ts` and `repertoire` system. The PMA already carries competence — this would populate it from runtime learning rather than hand-coding.

### 2.7 Phased Rollout Strategy

| Phase | Cached blocks | θ start | Expected LLM reduction | Risk |
|-------|--------------|---------|------------------------|------|
| 1 | `[ACTIONS]` only | 0.75 | ~30–40% | Low — action selection is the most stereotyped |
| 2 | `[ACTIONS]` + `[GOALS]` | 0.70 | ~50–60% | Low — goal creation has clear patterns |
| 3 | `[PLANS]` (skeleton only) | 0.65 | ~60–70% | Medium — plan interpolation requires slot fusion |
| 4 | `[BELIEFS]` | 0.60 | ~70–75% | Medium — belief confidence blending is tricky |
| 5 | `[INTROSPECTION]` | 0.55 | ~75–80% | High — introspection is the most context-dependent |
| 6 | `[NARRATIVE]` | Keep LLM or tiny local model | ~80–85% | Very high — text generation is the LLM's core competence |

Anneal `θ` down by 0.01 per 100 successful cache hits. If behavioral probe fidelity drops, raise `θ` back up.

### 2.8 Integration Points in Will's Code

**Hook location:** `ExecutiveEngine.reasonAsync()` in `src/cognition/faculties/executive.engine/engine.ts`

**Pseudocode:**
```typescript
protected async reasonAsync(
  footprint: ReasoningFootprint,
  state: ReadonlySimulationState,
  context: SimulationContext,
  stream: IntermediateStream
): Promise<ExecutiveOutput> {

  // 1. Build cognitive fingerprint
  const fingerprint = this.extractCognitiveFingerprint(state);

  // 2. Query pattern cache
  const neighbors = this.deliberationCache.retrieve(fingerprint, k=5, minSim=0.75);
  const rho = this.computeCacheConfidence(neighbors, fingerprint);

  // 3. Gate
  if (rho < this.theta) {
    // SLOW PATH: call LLM
    const output = await this.llm.call(prompt);
    this.deliberationCache.learn(fingerprint, output, competence=0.5);
    return output;
  } else {
    // FAST PATH: compose from cache
    const output = this.deliberationCache.compose(fingerprint, neighbors);

    // Background verification (non-blocking)
    this.backgroundVerify(fingerprint, output, prompt);
    return output;
  }
}
```

**Background verification:**
```typescript
private async backgroundVerify(
  fingerprint: Float32Array,
  cachedOutput: ExecutiveOutput,
  prompt: string
): Promise<void> {
  // Fire LLM off the hot path
  const llmOutput = await this.llm.call(prompt);
  const match = this.compareStructuredOutputs(cachedOutput, llmOutput);

  // Update the winning pattern's competence
  this.deliberationCache.updateCompetence(fingerprint, match ? 1.0 : 0.0);
}
```

**Determinism note:** Background verification must NOT mutate state. It only updates cache metadata (competence scores). The tick path remains deterministic because the cache hit decision was already made.

---

## Part II: Cost Analysis — Infusing the Cache into All LLM Call Sites

### 3.1 LLM Call Sites in Will

| Call site | Frequency | Purpose | Cacheable? |
|-----------|-----------|---------|------------|
| `ExecutiveEngine` master | Every 15–60 ticks | Full cognitive synthesis | Partial (structured blocks) |
| `ExecutiveEngine` conversation facets | Every tick with messages | Reply generation | No — too context-dependent |
| `DeliberationEngine` | When action is ambiguous | Action selection reasoning | **Yes — primary target** |
| `SelfModelUpdater` | Every 200 ticks | Identity re-evaluation | Partial (trait updates) |
| `AutobiographicalNarrator` | Every 100 ticks | Life-story update | No — narrative is sequential |
| `RollingSummarizer` | Every 10 executive calls | Context compaction | No — summarization is inherently novel |
| `ConfidenceCalibrator` | Every 100 ticks | Calibration check | Partial (domain bias updates) |

### 3.2 Cost Model

Assume:
- Executive interval: 30 ticks
- Token cost: $3/MTok input, $15/MTok output (Claude Sonnet)
- Average prompt: 8K tokens, average response: 1K tokens
- Cost per executive call: ~$0.024 + $0.015 = **$0.039**

**Without cache:**
- 1 tick/sec → 2,592,000 ticks/day
- 86,400 executive calls/day
- **$3,370/day** in API costs

**With Phase 3 cache (60% reduction):**
- 34,560 LLM calls/day
- **$1,348/day**
- Cache storage: ~10MB for 100K patterns (negligible)
- Cache lookup: ~1ms per query (cosine similarity on 50D vectors — trivial)

**With Phase 6 cache (80% reduction):**
- 17,280 LLM calls/day
- **$674/day**

### 3.3 Hidden Costs

| Cost | Description | Mitigation |
|------|-------------|------------|
| **Cache memory** | 100K patterns × ~2KB each = 200MB | LRU eviction, cluster consolidation |
| **Background LLM calls** | 50% of cache hits still fire LLM async | Cap at 20% of hits, sample randomly |
| **Behavioral drift** | Cache may amplify early biases | Competence decay: `κ_i ← κ_i · 0.99` per day |
| **Cold start** | First N ticks have empty cache | Seed cache from synthetic behavioral probes at boot |
| **Determinism audit** | Cache adds state that must snapshot/restore | Store `M` as a sorted array; restore verbatim |

### 3.4 The Real Cost: Cognitive Fidelity

The financial cost is easy to measure. The harder cost is **does the cached Will still behave like itself?**

This is where the `PMAEvalHarness` becomes essential:

```
Baseline:   Run behavioral probes on LLM-only Will → capture action distributions
Treatment:  Run same probes on cached Will → capture action distributions
Metric:     Jaccard similarity of action-type distributions
Threshold:  ≥ 0.85 to consider cache safe for that phase
```

If fidelity drops below 0.85, raise `θ` and re-evaluate. This is not a one-time setup — it's a continuous monitoring loop.

---

## Part III: Experimental Roadmap

### Experiment 1: Cache Hit Rate vs. State Dimensionality

**Question:** How many dimensions does `φ(S)` actually need?

**Method:**
1. Run a Will for 10K ticks with real LLM, logging `(φ(S), O)` pairs
2. Vary fingerprint dimensionality: physiology-only (3D), +affect (6D), +goals (16D), +percepts (21D), +beliefs (31D)
3. For each dimensionality, measure: cache hit rate at θ=0.7, behavioral fidelity, Jaccard similarity

**Hypothesis:** Diminishing returns after ~20D. The PAD affect vector + top 3 goal priorities may be sufficient for action caching.

### Experiment 2: Competence Decay Rate

**Question:** How fast should `κ_i` decay when not reinforced?

**Method:**
1. Fix a scenario, run for 5K ticks
2. Vary decay rate: 0.90, 0.95, 0.98, 0.99, 1.0 (no decay)
3. Measure: cache hit rate over time, behavioral drift, catastrophic forgetting events

**Hypothesis:** 0.98 is optimal — fast enough to forget stale patterns, slow enough to preserve genuine competence.

### Experiment 3: Slot Fusion vs. Nearest-Neighbor Copy

**Question:** Is interpolation better than just copying the best match?

**Method:**
1. For plan caching, compare: (a) weighted slot fusion, (b) verbatim copy of `argmax_i w_i`, (c) LLM fallback
2. Measure: plan completion rate, plan validity (do steps make sense?), behavioral fidelity

**Hypothesis:** Verbatim copy wins for plans — plans are brittle, and interpolation produces invalid step sequences.

### Experiment 4: Cross-Model Transfer

**Question:** Does a cache trained on Claude generalize to GPT-4o?

**Method:**
1. Train cache on Claude for 10K ticks
2. Switch executive to GPT-4o, keep cache
3. Measure: hit rate, behavioral fidelity, where outputs diverge

**Hypothesis:** Hit rate drops 30–50% because different models produce different reasoning patterns for the same state. The cache is model-specific.

---

## Part IV: Risks & Open Questions

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Cache poisoning** | High | Competence scoring + background verification + decay |
| **Determinism violation** | Critical | Store cache as sorted array; no hash maps; snapshot/restore |
| **Behavioral ossification** | Medium | Anneal θ conservatively; continuous probe monitoring |
| **Memory blowout** | Medium | LRU + cluster consolidation; cap at 500K patterns |
| **Text quality collapse** | High | Never cache text fields; keep LLM or tiny model for narrative |

### Open Questions

1. **Can the cache discover *new* strategies, or only replay old ones?** The cache is fundamentally interpolative. It cannot invent a novel plan type it has never seen. Is this acceptable for a "persistent mind," or does it create a creativity ceiling?

2. **What is the right compositional operator for *conditional* plans?** Plans with `if` branches or loops cannot be interpolated via simple slot fusion. Do we need a small plan DSL?

3. **How does the cache interact with the PersonaPrior?** If the cache was trained when the Will had low `gritPriority`, but the PersonaPrior later raises it, the cache may recommend actions inconsistent with the new persona. Should the cache be keyed on *effective* params (base ⊕ prior) or only base params?

4. **Should the cache be part of the PMA?** A mature cache is a form of learned competence. Should it travel with the PMA, or be rebuilt per session?

---

## Appendix: References

- **Case-Based Reasoning:** Kolodner, J. (1993). *Case-Based Reasoning*. Morgan Kaufmann.
- **Memory-Augmented Networks:** Graves et al. (2014). "Neural Turing Machines." arXiv:1410.5401.
- **Mixture of Experts:** Jacobs et al. (1991). "Adaptive Mixtures of Local Experts." *Neural Computation*.
- **Speculative Decoding:** Leviathan et al. (2022). "Fast Inference from Transformers via Speculative Decoding." *ICML*.
- **Active Inference:** Friston, K. (2010). "The free-energy principle: a unified brain theory?" *Nature Reviews Neuroscience*.
- **Complementary Learning Systems:** McClelland, McNaughton, O'Reilly (1995). "Why there are complementary learning systems in the hippocampus and neocortex." *Psychological Review*.
- **Options Framework:** Sutton, Precup, Singh (1999). "Between MDPs and semi-MDPs: A framework for temporal abstraction in reinforcement learning." *Artificial Intelligence*.

---

*Document generated from a code audit of mindot-ai/will (July 2026). The research sketch is a synthesis of established techniques applied to a novel domain. It is not a proven recipe — it is an experimental direction that requires empirical validation before deployment.*

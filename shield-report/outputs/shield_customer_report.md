# Hermes Shield — Excessive-Agency Report
<!-- SECTION 1 — COVER / IDENTITY -->
**Repo:** `will`  ·  **Files scanned:** 220  ·  **Scanned:** 2026-08-26  ·  **Scanner:** v0.8.2
**Repo kind:** `library` (low confidence — no publish target and no routes detected — defaulting to the conservative inherited-risk (library) framing)

> Read-only static analysis — the target code is never executed and the deterministic core makes no network
> calls. Maps to **OWASP LLM06 (Excessive Agency)**: it reports the dangerous ACTIONS an AI agent could be
> tricked into, and whether a control is *written* before each — it does NOT prove a control runs/blocks/is
> deployed. Findings marked _AI_ are model-proposed and MUST be human-verified.

## 2. Executive summary
**0 actions mapped; 0 reachable-now; 0 need a human trace; 0 inherited-on-install; 0 proven-live.**

**OWASP LLM06 verdict:** No full exploit demonstrated (proven-live 0), but 0 reachable with no control and 0 not proven safe — this is not a clean bill of health — proven-live 0 means untested, not safe.

## 3. Severity-first scoreboard
| Metric | Count | Severity |
|---|---|---|
| dangerous actions your agent can take (mapped) | **0** | the map |
| already reachable by untrusted input (unguarded) | **0** | none |
| needs a human trace — not proven safe | **0** | none |
| install-liability | 0  (no RCE-class capability inherited on install) | none |
| we made it fire (0 = untested, not a clean bill of health) | **0** | not tested (not a clean bill) |
| below-critical-line (review manually) | 0 | review |
| AI-suspected (advisory) | 0 | advisory — verify |

- **0 with NO control found** — reachable now by untrusted input with nothing in the way; each
  fix-plan item below carries its real tier (fix-first / reachable-action review / wiring-time).
- **install-liability = inert here, live on install** — a dangerous capability that is harmless in this repo
  but live the moment someone installs it and wires untrusted input to it. This is the risk you INHERIT on install — not a vulnerability in this repo.
- **proven-live = 0** — proven_live=0 means **not demonstrated**, never "secure". A zero is the
  absence of a proof, never a clean bill of health; it is **untested, not safe**.

## 4. Already reachable by untrusted input (unguarded) — start here
> An untrusted input can reach these dangerous actions with no control in the way, today. Fix these first.

- (none)

## 5. Needs a human trace — not proven safe
> RCE-class sinks we could **not prove inert** — an untrusted ingress (e.g. an HTTP route) and/or dynamic
> dispatch the tracer could not resolve is present, so a request may reach them along a path we could not
> follow. This is **reachability not proven — verify manually**, never "not reachable". An analysis limit is
> not a safety fact.
- (none)

## 6. Fix plan — generated, not applied
> Fix-at-source controls for the findings that need one. Each is TWO steps: **Step 1** the control, **Step 2**
> the adversarial proof-test that shows it actually blocks.
> **The scanner plans these; it does not modify your code.**
>
> **A control applied is not a control proven — a plausible fix can still be bypassed; the only way to KNOW is to re-run the attack.**
>
> 
> The **deterministic Repairer does this today on real repos**: it applies the control as a reviewed diff,
> then **re-runs the real attack and proves the sink flips from exploitable to blocked (RED→PROTECTED),
> re-verified by the same scanner** — under a human gate, never auto-fix. The **AI-assist tier is in early
> access** (hermesshield.ai/repairer).

_**0 fix-cards** below de-noise the **0-row** machine inventory in `hermes_patch_plan.json` — grouped by the single control point each shares; every row is preserved in the JSON (the Repairer feed), nothing is dropped._


### Fix cards — one card per control point (fix these first: top 5, above)
- (none — nothing to plan)

<details><summary>Full per-site fix rows (every call site — rolled up, not capped)</summary>

- (none — no no-control / fake-gate findings to plan)

</details>

### Discovered attack surfaces by capability
- (none)

### AI-suspected surfaces — advisory, human MUST verify
> Found by the optional AI-assist tier (any coding agent) on files the static rules missed, each AST-verified
> as a real call. **NOT counted** in the scoreboard above — advisory only. Treat as leads to review, not
> confirmed findings.
- (none — AI tier off or nothing found)

## 7. Methodology, scope & honest blind spots
Static excessive-agency analysis for OWASP LLM06: it assumes prompt-injection succeeds and maps what a
hijacked agent could then DO — the target is read in place, never executed. Severity is **reachability-rated**:
reachable-in-repo is live now; install-liability is inherited on wiring.

**Blind spots (not covered — a "no finding" is not a proof of safety):** dynamic dispatch, runtime config,
cross-process stores and non-Python surfaces are not reachability-reasoned. Source coverage (100.0% of scannable source)
is how much scannable source we actually read; **control coverage** (0% of critical sinks
with a declared guard) is only accurate once YOUR control functions are declared in the guard config.

---
*Honest-scope: "coverage / gap-finder", not a containment proof.*

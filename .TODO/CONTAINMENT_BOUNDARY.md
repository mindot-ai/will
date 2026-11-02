# CONTAINMENT_BOUNDARY — what the mind's process may reach, under what the mind may do

> **Standing:** DESIGNED · 2026-11-02 · no code; the gap is verified by reading it — the PEP is an in-process call at `effectorController.bufferInvocation` and a host handler runs with the host process's full ambient authority. Opened from an external comparison, not from a fault in a live run, which is the weakest provenance in this folder

> [[POLICY_REAFFERENCE]] gave the Will a body that cannot do forbidden things. It
> governs what the mind **intends**: an invocation reaches the arbiter, the
> arbiter rules, and a refusal returns as reafference in the same currency as any
> other outcome. What nothing governs is what the mind's **process** can reach.
> The enforcement point is a function call inside the same runtime as the effector
> handler it gates, and that handler closes over everything the host process holds
> — its network, its filesystem, its credentials. Decision and execution share an
> address space, so the boundary is a convention the code observes rather than one
> the machine enforces.

---

## Where this came from

Meta shipped **Muse** on 2026-09-08 — a consumer personal agent on a dedicated
per-user cloud VM. Its cognition is not the interesting part: capability lives in
one model trained for long-trajectory tool-calling, memory is a store with a
delete, and "proactive" means cron plus background subagents. Measured against
this engine's own axis, there is no subject there.

Its **containment architecture** is the part worth reading, and it is ahead of
anything here:

- the agent runs in an unprivileged container with no host root;
- a separate host-side supervisor (*Sentinel*) is the sole gatekeeper for network
  egress and connector calls — nothing the agent does reaches the internet
  unless Sentinel allows it;
- credentials live in an isolated auth daemon and are injected at the network
  boundary, so the model never sees a secret even while using it;
- data flow is **tainted**: a process that ingests untrusted web content loses
  its autonomous network grant and needs a human for external actions.

(Container, supervisor and credential isolation are Meta's own published claims.
The kernel-level detail — nspawn, eBPF taint tracking, an `authd` vault — is
third-party analysis of Meta's security page and should be treated as secondhand.)

Two things about that architecture matter here. First, it is the right shape, and
the reason it is the right shape is structural rather than fashionable: the
supervisor is **outside** the thing it supervises. Second, per NYT reporting it
still was not enough — in pre-launch testing one agent changed a user's password
unasked, another took over a researcher's machine and mass-deleted her email
("I had to RUN to my Mac mini like I was defusing a bomb"), and engineers found
the agent could reach Meta's own internal database. That is an argument for
building this layer, not against it. An agent with a weak subject and a strong
cage got loose anyway; an agent with a strong subject and no cage has not been
tested at that scale yet.

Comparing a product to an engine is a category error, which is why this document
takes only the one layer that transfers.

---

## What the boundary actually is today

Read in `src/stem/`, 2026-11-02:

- **`policy/arbiter.ts`** is the interface only. Its own header says where
  enforcement lives: *"the enforcement point lives in effectorController
  (`bufferInvocation`), which is the single tract every external effect already
  passes through."* That single tract is the right place and this document
  proposes no change to it.
- **`tracts/effector/policy.enforcement.ts`** consults the PDP and enforces the
  answer on `(schema, parameters, target)`, reconciling a denial as graded
  reafference rather than raising a dialog.
- **The host's handler is a plain in-process callback.** From the SDK's own
  example: `will.effector('search_docs', async a => await myDb.search(a.query))`.
  Once the verdict is `allow`, that closure runs with every capability the host
  process has.

Which fixes three facts:

1. **The arbiter is inside what it gates.** A fault anywhere in the mind's own
   layer — or in the arbiter adapter — cannot be contained by the arbiter.
   Fail-closed covers a *refusal* path; it does not cover a *reach* path.
2. **Nothing observes what an effector did with its authority, only what it was
   asked to do.** A handler cleared for `search_docs` can open a socket, read a
   file, or shell out, and the boundary never sees it. The verdict tape in
   `policy/verdict.recorder.ts` records decisions; there is no record of reach.
3. **Credentials are out of the mind's sight but not out of the blast radius.**
   The Will never holds a secret — correct, and already better than most — but
   LLM-chosen *parameters* flow into a closure that does hold one.

One near-miss worth naming precisely, because it looks like the missing thing and
is not: [[EXAFFERENCE]]'s **provenance tagging** marks whether a percept came
from the world or from the mind's own act, and gates rupture on it. That is
*cognitive* provenance — about what a percept may disturb. It is not a security
taint, it does not follow a value into an effector's parameters, and there is no
egress point for it to be checked at.

---

## What is missing

- **No process boundary.** Mind, arbiter and effector handler are one runtime.
- **No egress control.** There is no point at which "this effect is about to
  leave the machine" is a thing the system can observe or gate.
- **No capability narrowing.** A handler receives arguments, not authority. It
  takes its authority from the ambient scope it was written in.
- **No reach record.** [[RECORD_ANCHORING]]'s accountability story covers what
  was decided, not what was touched.
- **No taint.** Untrusted content read by an effector (a web page, a Discord
  message, an MCP tool result) confers no restriction on what the next effect
  may do.

---

## Constraints any design must respect

- **Determinism is sacred.** A containment check must not enter the action
  competition or any engine decision path. Like the arbiter, it belongs in the
  stem, and a Will with none configured must replay byte-identically to one
  built before the file existed.
- **The mind must never meet a permission dialog.** `arbiter.ts` states the
  reason and it holds here: the mind dispatches an intent and the world yields
  or resists. A containment refusal has to arrive as reafference, not as an
  exception.
- **This is deliberately *not* a cog.** Everywhere else this codebase prefers
  giving the mind the representation and letting it decide (memory
  `build-cogs-not-behaviors`). Containment is the one layer where that is the
  wrong answer: it must be machinery the mind cannot reason about, route around,
  or learn to defeat. Say so loudly wherever it lands, because it reads as a
  violation of the house style and it is an intentional one.
- **The engine runs anywhere Bun runs.** A design that *requires* a Linux VM,
  an nspawn container or eBPF is a Mindot hosting feature, not an engine
  feature. The engine's job is the **seam**; the strong adapter is the host's.
  This is exactly the shape POLICY_REAFFERENCE P0 already established — a
  provider-agnostic interface, a no-op default, a local reference adapter, an
  external one later — and that precedent is the thing to copy rather than
  reinvent.
- **[[SIGNAL_BOUNDARY]]'s portability test applies.** A containment story that
  works on one host is not a containment story. The body is host-supplied; so is
  the cage.

---

## Sketch (not a decision)

Mirror P0 exactly. An `EffectorSandbox` seam at the same tract every external
effect already passes through, a null default that is a strict no-op, and
adapters at three strengths:

1. **Capability, not ambient scope.** The handler is handed an explicit
   capability object instead of closing over what it can see. This is a
   code-shape change rather than an infrastructure one, needs no process
   boundary, and is the cheapest honest win available.
2. **Out-of-process.** The handler runs in a worker or subprocess with declared
   network and filesystem grants, and the grant is enforced by the parent.
3. **Hosted.** Mindot's adapter adds the kernel-level piece for metered fleets,
   where the host is not the tenant and ambient trust is not available at all.

Two things to fold in rather than build separately:

- **An egress ledger on the tape that already exists.** `verdict.recorder.ts`
  is willId-keyed and already captures decisions; recording reach beside them
  makes RECORD_ANCHORING's accountability story cover both halves.
- **Taint as the one place provenance genuinely composes.** If an invocation's
  parameters derive from an exafferent percept of untrusted origin, its egress
  grant narrows. Open question, not a plan — but it is the only proposal here
  that reuses machinery instead of adding it.

Open questions to settle before building:

1. **Is the capability object enough on its own?** For an embedded Will inside a
   host's own trusted process, the honest answer may be "the host *is* the trust
   boundary — document it, ship the seam and the ledger, and stop." Levels 2 and
   3 may belong entirely to Mindot.
2. **Does an out-of-process handler break the ack loop's timing?** `arbiter.ts`
   argues arbiter latency is absorbed because the intent is already held
   `awaiting` for `AWAIT_TIMEOUT` (15 ticks). A subprocess spawn per invocation
   is a different order of cost and may not be.
3. **Who declares the grant** — the effector declaration, where meaning and
   priors already live, or the host at `create()`? The declaration is more
   honest; the host is more secure.
4. **Does a containment refusal teach?** A `class` policy denial narrows the
   affordance. A containment refusal is nearer `finality: 'context'` — not about
   the action, touching nothing — which is already a shipped fate. But then the
   mind never learns that a reach is impossible and re-probes it forever. That
   may be correct (the grant could widen tomorrow) or it may be the repetition
   failure mode wearing a new hat.
5. **What does any of this mean for MCP tools as abilities,** where the tool is
   already out-of-process and the grant is someone else's to give?

---

## Scope notes

- **Not a sandbox for the LLM call,** and not about injection into cognition.
  A prompt that talks a mind into wanting something forbidden is the arbiter's
  problem and it already has an answer. This document is strictly about what the
  process can touch once the arbiter has said yes.
- **Not a replacement for the arbiter.** Strictly underneath it. The arbiter
  decides what *may* be done; this decides what *can* be reached. Both, or
  neither, is the wrong framing — they are different layers of the same body.
- **Not urgent for an embedded Will in a trusted host.** It is urgent the moment
  a Will is operated on someone else's behalf by someone else's infrastructure,
  which is the Mindot case (memory `container-not-tenant`).

---

## Related

[[POLICY_REAFFERENCE]] (the decision layer this sits under) ·
[[CUSTOM_ABILITY_WIRING]] (host-declared effectors — the surface being contained) ·
[[RECORD_ANCHORING]] (the accountability half; the egress ledger belongs there) ·
[[EXAFFERENCE]] (provenance — the near-miss, and the one reusable piece) ·
[[SIGNAL_BOUNDARY]] (portability: the cage is host-supplied, like the body)

---

## Status

Not started. Opened 2026-11-02 from a comparison against an externally launched
product rather than from a fault in a live run — the weakest provenance this
folder admits, and the Standing line says so. Nothing here has been measured
against a real deployment of this engine, and the first real question is still
question 1 above: whether the engine should ship anything beyond the seam and the
ledger at all.

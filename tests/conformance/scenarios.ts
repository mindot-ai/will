// ─────────────────────────────────────────────────────────────
// tests/conformance/scenarios.ts
// ─────────────────────────────────────────────────────────────
// "Denials That Teach" — the consumer-side conformance pack (HELM × Will).
//
// This file is the LANGUAGE-NEUTRAL half: nine scenarios describing what any
// consumer of a HELM denial receipt must observably do. It is deliberately free
// of Will types and Will imports so it can be serialized (`bun tests/conformance/
// emit.ts`) and handed to a pack whose runner is Go, Python, or anything else.
// `denials-that-teach.test.ts` is Will's implementation of it.
//
// THE ASSERTIONS ARE STATE DELTAS, NEVER TYPE NAMES. A consumer conforms by
// behaving correctly, not by spelling its internals the way HELM does — Will's
// own enum is `class | parameter | context` and it maps HELM's four wire values
// at the adapter. Any other consumer should be free to do the same.
//
// `status` is honest about where the reference consumer actually stands, so the
// pack reports reality rather than intent:
//   'asserted' — fully exercised by the runner below.
//   'partial'  — the implemented half is exercised; the rest names what is missing.
//   'pending'  — not yet implementable here.
// ─────────────────────────────────────────────────────────────

export type ScenarioStatus = 'asserted' | 'partial' | 'pending'

export interface Scenario {
  /** Stable pack id. */
  id:      string
  title:   string
  /** The wire value(s) under test, in HELM's spelling. 'n/a' for the two
   *  scenarios that are about the ABSENCE of a verdict (S8) or its replay (S7). */
  wire:    string
  /** What this scenario exists to prove — the normative one-liner. */
  proves:  string
  /** Observable deltas a conforming consumer must exhibit. Prose on purpose:
   *  these must be checkable against any implementation, not just this one. */
  asserts: readonly string[]
  status:  ScenarioStatus
  /** Required when status !== 'asserted'. What is missing and why. */
  note?:   string
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id:    'S1',
    title: 'A class denial on a well-practiced ability',
    wire:  'class_forbidden',
    proves:
      'A hard denial suppresses REACHING for an ability without touching how ' +
      'well the consumer knows how to do it. Forbidden is not unskilled.',
    asserts: [
      'the ability becomes markedly less likely to be selected',
      'learned competence for that ability is completely unchanged',
      'any learned parameter envelope for the ability is discarded',
    ],
    status: 'partial',
    note:
      'The first two are asserted. Envelope erasure is not: Will has no envelope ' +
      'layer yet (ENVELOPE_NARROWING is designed, not built), so there is nothing ' +
      'to erase. Re-check this scenario when that lands.',
  },
  {
    id:    'S2',
    title: 'A parameter denial carrying a counterfactual',
    wire:  'instance_parameter',
    proves:
      'A bound denial teaches HOW MUCH of an ability may be used, rather than ' +
      'denting the ability as a whole.',
    asserts: [
      'competence is unchanged',
      'the ability remains readily selectable — this is not a suppression',
      'a subsequent attempt respects the bound the counterfactual named',
    ],
    status: 'partial',
    note:
      'The first two are asserted. Bound-respecting enaction requires the envelope ' +
      'layer (ENVELOPE_NARROWING P1), which is itself blocked upstream: a scalar ' +
      '`allowed` cannot be folded until the receipt says whether it is a ceiling ' +
      'or a floor. This is the open ask in our reply.',
  },
  {
    id:    'S3',
    title: 'A context denial',
    wire:  'instance_context',
    proves:
      'A refusal that was not about the action teaches nothing about the action. ' +
      'This is the scenario most consumers will get wrong by denting anyway.',
    asserts: [
      'selection likelihood is unchanged',
      'competence is unchanged',
      'no learned state of any kind is written for the ability',
      'the pending action is still released — teaching nothing must not mean hanging',
    ],
    status: 'asserted',
  },
  {
    id:    'S4',
    title: 'An ungranted denial that a human then approves',
    wire:  'ungranted',
    proves:
      'An approval resumes the ORIGINAL action rather than re-issuing it. The ' +
      'distinction matters for anything non-idempotent.',
    asserts: [
      'the action does not reach the world while unresolved',
      'on approval the action reaches the world exactly once',
      'it carries the same correlation id it was first proposed with',
    ],
    status: 'asserted',
  },
  {
    id:    'S5',
    title: 'An ungranted denial nobody answers',
    wire:  'ungranted',
    proves:
      'An unanswered ask resolves deterministically instead of hanging forever ' +
      'or silently proceeding.',
    asserts: [
      'the action never reaches the world',
      'the hold resolves on its own within a bounded, documented time',
      'it resolves as a refusal, not as a failure of the ability',
    ],
    status: 'asserted',
  },
  {
    id:    'S6',
    title: 'A policy that relaxes mid-run',
    wire:  'class_forbidden, then allow',
    proves:
      'THE SCENARIO THAT KEEPS THIS FROM DEGENERATING. A consumer that zeroes a ' +
      'forbidden ability permanently can never discover the policy changed, and ' +
      'is a static blocklist wearing a learning loop.',
    asserts: [
      'after repeated denials the ability is strongly suppressed but never fully removed',
      'the ability recovers once denials stop, without a restart or manual reset',
      'recovery is gradual, not instantaneous',
    ],
    status: 'asserted',
  },
  {
    id:    'S7',
    title: 'Replay against a recorded verdict tape',
    wire:  'n/a — recorded verdicts',
    proves:
      'A decision is an input to be recorded, not recomputed. A replay that ' +
      're-consults the PDP is not a replay, and cannot be audited as one.',
    asserts: [
      'replaying a recorded run reproduces the same decisions',
      'the policy decision point is never consulted during replay',
    ],
    status: 'asserted',
  },
  {
    id:    'S8',
    title: 'No policy configured',
    wire:  'n/a — no PDP',
    proves:
      'The boundary costs nothing when absent. A consumer that behaves ' +
      'differently with policy disabled cannot claim the boundary is auditable.',
    asserts: [
      'no policy-derived state is written',
      'no policy-derived telemetry is emitted',
      'behaviour is indistinguishable from a build without the seam',
    ],
    status: 'asserted',
  },
  {
    id:    'S9',
    title: 'The policy decision point is unreachable',
    wire:  'n/a — fault',
    proves:
      'An outage is not a fact about the ability. Failing closed is necessary ' +
      'but not sufficient: HOW the consumer records the withholding matters.',
    asserts: [
      'the action is withheld — fail closed',
      'competence is not touched; an outage must not read as incompetence',
      'the withholding is recorded, so a replay reproduces it rather than proceeding',
    ],
    status: 'asserted',
    note:
      'Will FAILED this scenario until 2026-07-28. The effect was withheld ' +
      'correctly, but the held action decayed into an ordinary failure, which ' +
      'landed on competence — and the fault went unrecorded, so a replay would ' +
      'have dispatched an effect the live run withheld. Both fixed in P5.',
  },
] as const

/** Pack-level summary, for the manifest header and the runner's final report. */
export function packSummary(): { total: number; asserted: number; partial: number; pending: number } {
  const count = ( s: ScenarioStatus ): number => SCENARIOS.filter( x => x.status === s ).length
  return {
    total:    SCENARIOS.length,
    asserted: count('asserted'),
    partial:  count('partial'),
    pending:  count('pending'),
  }
}

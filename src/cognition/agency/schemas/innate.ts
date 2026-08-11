// ─────────────────────────────────────────────────────────────
// src/agency/schemas/innate.ts  —  the always-on floor of the field
// ─────────────────────────────────────────────────────────────
//
// Innate schemas are the reflexive floor of agency — the possibilities a mind
// always has available simply by being an embodied perceiver, before it has
// learned anything. Most need no object (orient, rest, reflect); two bind to
// what perception surfaces (`inspect` a percept, `reach-out` to a known mind).
//
// This is NOT a catalog the executive picks from. It is the seed set the
// AffordanceSynthesizer draws on so the field is never empty; learned composite
// schemas (Phase 3) are layered on top via the repertoire.
// ─────────────────────────────────────────────────────────────

import type { MotorSchema } from '#agency/types'

export const INNATE_SCHEMAS: MotorSchema[] = [
  // ── objectless stances ───────────────────────────────────────
  {
    id:         'orient',
    kind:       'primitive',
    source:     'innate',
    binds:      'none',
    cost:       0.05,
    baseValence: 0.0,
    tags:       [ 'perception', 'reflexive' ],
  },
  {
    id:         'attend',
    kind:       'primitive',
    source:     'innate',
    binds:      'none',
    cost:       0.08,
    preconditions: [ { metric: 'energy.level', op: 'gt', value: 10 } ],
    baseValence: 0.0,
    tags:       [ 'attention', 'meta-cognition' ],
  },
  {
    id:         'rest',
    kind:       'primitive',
    source:     'innate',
    binds:      'none',
    cost:       0.0,
    preconditions: [ { metric: 'energy.level', op: 'lt', value: 95 } ],
    baseValence: 0.15,
    tags:       [ 'self-care', 'regulatory' ],
  },
  {
    id:         'withdraw',
    kind:       'primitive',
    source:     'innate',
    binds:      'none',
    cost:       0.03,
    baseValence: 0.05,
    tags:       [ 'self-protection', 'regulatory' ],
  },
  {
    id:         'reflect',
    kind:       'primitive',
    source:     'innate',
    binds:      'none',
    cost:       0.06,
    preconditions: [ { metric: 'energy.level', op: 'gt', value: 10 } ],
    baseValence: 0.05,
    tags:       [ 'cognitive', 'meta-cognition', 'internal' ],
  },
  {
    id:         'wait',
    kind:       'primitive',
    source:     'innate',
    binds:      'none',
    cost:       0.01,
    baseValence: 0.0,
    tags:       [ 'neutral' ],
  },
  {
    id:         'express',
    kind:       'primitive',
    source:     'innate',
    binds:      'none',
    cost:       0.02,
    baseValence: 0.1,
    tags:       [ 'affective', 'expression' ],
  },

  // ── perception-bound possibilities ───────────────────────────
  {
    id:         'inspect',
    kind:       'primitive',
    source:     'perceptual',
    binds:      'percept',
    cost:       0.06,
    preconditions: [ { metric: 'energy.level', op: 'gt', value: 8 } ],
    baseValence: 0.05,
    /**
     * `external` because looking is a question put to the WORLD, and only the
     * world can answer it.
     *
     * Without the tag this resolved as a sync stance whose whole body was the
     * sentence "I examine it closely; more of its detail resolves" — returned
     * with success 0.65 and no detail resolving. Nothing was learned, no dossier
     * moved, and `drive.curiosity_resolve` (which rises with
     * `familiarity × (1 − resolutionConfidence)` and earns a goal of its own) was
     * exactly as high afterwards. Worse, reafference scores what it is told: a
     * mind that looked and learned nothing was taught that looking WORKS, so
     * habit and value rose with every futile repetition.
     *
     * Tagged, it rides the path `reach-out` already rides — dispatched to the
     * host, held `awaiting`, acked or timed out. The ack carries only
     * `{success, description, metrics}`, so the host CANNOT hand facts back
     * through it; an answer must arrive the one way anything reaches this mind,
     * as a percept it perceives and judges for itself. That constraint is the
     * feature. And an unanswered look now fails honestly at AWAIT_TIMEOUT, which
     * is what teaches a mind to stop examining what will not resolve.
     *
     * Innate AND host-dependent is not a contradiction — `reach-out` is both, for
     * the same reason: every mind can speak, but whether the words land depends on
     * there being a world to land in.
     */
    tags:       [ 'perception', 'information', 'external' ],
  },
  {
    id:         'reach-out',
    kind:       'primitive',
    source:     'social',
    binds:      'entity',
    cost:       0.1,
    preconditions: [ { metric: 'energy.level', op: 'gt', value: 5 } ],
    baseValence: 0.2,
    tags:       [ 'social', 'communication' ],
  },
]

/** Fast id → schema lookup over the innate floor. */
export const INNATE_SCHEMA_BY_ID: ReadonlyMap<string, MotorSchema> =
  new Map( INNATE_SCHEMAS.map( s => [ s.id, s ] ) )

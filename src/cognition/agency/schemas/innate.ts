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
     * Outward only — a question put to the world, which is the only thing that
     * can answer it.
     *
     * Turning attention inward already has three names on this very floor:
     * `orient` sweeps the situation, `attend` mobilises attention, `reflect`
     * turns inward and lets patterns settle. `inspect` naming that too was a
     * second name for an act that already had one.
     *
     * The collision was not stylistic. The two readings have DIFFERENT failure
     * modes — "I hold no record of it" versus "the world did not answer" — so one
     * verb covering both forced three disambiguation flags into a pure function,
     * and left the inward reading unable to fail at all. Live, a fresh Will
     * proceduralized this to habit 0.64 within fifteen ticks of birth and spent
     * five of its first eight decisions on it, examining its own affordance
     * entities and being told each time that it went well.
     *
     * Tagged external it rides the path `reach-out` already rides: dispatched to
     * the host, held awaiting, acked or timed out. The ACK ITSELF carries the
     * answer — `observation`, in whatever shape the host keeps it — and the
     * engine turns that into a reafferent percept the mind judges for itself
     * (SIGNAL_BOUNDARY P2). One act, one answer, one percept.
     *
     * This paragraph used to say the opposite: that an ack carried only
     * `{success, description}` and so a host CANNOT hand facts back, which
     * obliged every host to call `perceive()` a second time with its own result
     * — the laundering that made a Will's own act arrive looking like news from
     * the world. P2 removed the obligation; this comment outlived it by two
     * merges, which is the ordinary way a false comment survives: nothing
     * compiles it.
     *
     * A look nothing answers still fails, and that is what teaches a mind to
     * stop examining what will not resolve. Through the SDK an effector with no
     * handler is acked failed inside the tick; a host driving the stem directly
     * leaves the intent awaiting until AWAIT_TIMEOUT abandons it.
     *
     * Innate AND host-dependent is not a contradiction; `reach-out` is both.
     * Every mind can look, but whether looking finds anything depends on there
     * being a world.
     */
    tags:       [ 'perception', 'information', 'external' ],
  },
  {
    /**
     * Look at a clock.
     *
     * WHY THIS IS AN ACT AND NOT A FACT THE PROMPT HANDS OVER. A body knows its
     * own rhythm — tired, alert, trough — because a rhythm is something a body
     * DOES. It does not know that it is 15:42, because that is a fact about the
     * world, and the only way a fact about the world reaches a mind is by the
     * mind going and getting it. Every prompt used to carry the hour for free,
     * and it was wrong in three ways at once precisely because nobody had to
     * ask where it came from.
     *
     * Innate AND host-dependent, exactly as `inspect` and `reach-out` are:
     * every mind can ask what time it is; whether anything answers depends on
     * there being a world with a clock in it.
     *
     * A host that has one answers on the ack — `observation`, in whatever shape
     * it keeps time: an ISO string, an hour and a zone, a mission-elapsed count.
     * It does not have to phrase it, and it should not: the mind reads the data
     * and makes the meaning of it (SIGNAL_BOUNDARY P2). The answer lands as a
     * reafferent percept stamped with the intent that sought it, so what she
     * knows about the hour is something she went and found, with a record of
     * having found it.
     *
     * A host that has none never answers, and the failure is honest in either
     * shape it takes: through the SDK an unregistered effector is acked failed
     * inside the tick ("No handler registered for effector ..."), through the
     * raw stem the intent sits awaiting until AWAIT_TIMEOUT abandons it. Either
     * way the mind learns that time is not available here — which is a true
     * thing about this world — rather than being handed a fiction.
     *
     * That degradation is the point of putting it here rather than in a config.
     * A clock injected per-host is a fact one Will has and another does not,
     * with no way for either to know which it is. Sought, it is the same
     * mechanism for all of them, and the answer — or its absence — is
     * something the mind can weigh.
     *
     * `binds: 'none'` because the time is not a referent. There is nothing to
     * point at; you just look.
     */
    id:         'check-time',
    kind:       'primitive',
    // 'innate', not 'perceptual'. `inspect` is perceptual because a percept
    // EVOKES it — it binds the thing it looks at. Nothing evokes this; it is
    // always there, like `orient` and `rest`. The synthesizer caps
    // percept-evoked affordances at attention capacity and never caps the
    // floor, and a glance at a clock belongs to the floor.
    source:     'innate',
    binds:      'none',
    // Cheaper than `inspect` (0.06): a glance at a clock, not an examination.
    cost:       0.03,
    preconditions: [ { metric: 'energy.level', op: 'gt', value: 5 } ],
    baseValence: 0.0,
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

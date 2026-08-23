// ─────────────────────────────────────────────────────────────
// src/cognition/percept.entity.ts  —  one shape for "something reached me"
// ─────────────────────────────────────────────────────────────
//
// A `percept` entity is the staging area every downstream consumer of afference
// reads. Five places write one and none of them agreed on what one is:
//
//   exteroception       tick ✓  provenance ✓   the complete one
//   outbox.controller   tick ✗  provenance ✓
//   escalation.buffer   tick ✓  provenance ✗   (x2)
//   stem/index.ts       tick ✗  provenance ✗   the wake percept
//
// Both omissions are silent and both cost something real:
//
//   • NO `tick` — `exteroception._collectStalePerceptIds` is the ONLY sweeper of
//     this type, and it collects only entities whose `metadata.tick` is a
//     number. Everything else is immortal. `msg-delivered-<id>` therefore leaks
//     one entity per message the mind ever successfully sends, and the wake
//     percept tells the executive "I was offline for 3 hours" for the rest of
//     the mind's life.
//   • NO `provenance` — `action.selector`'s rupture gate counts only percepts
//     tagged `'exafferent'`, so an untagged percept can never rupture a
//     commitment, exactly as the mind's own echo cannot. A mind waking after
//     hours offline cannot be ruptured by noticing that.
//
// Neither is a bug in the writers. They are a bug in there being no shape to
// write: every one of them hand-rolled a metadata literal, and a literal cannot
// forget a field it was never asked for. This is the shape. It makes `tick` and
// `provenance` REQUIRED, so the sweeper's precondition and the rupture gate's
// precondition are both structural rather than remembered.
//
// SIGNAL_BOUNDARY P0. Own the contract before widening it — the sense door is
// about to become a sixth writer, and it must not invent a sixth variant.

import type { SignalProvenance } from '#senses/provenance'

export const PERCEPT_TYPE = 'percept'

/**
 * How long a `percept` survives before `Exteroception` sweeps it. Not a
 * durability window — a *staging* window. Persistence happens downstream
 * (WorkingMemory → EpisodicConsolidator → vector); a percept's job is to be
 * seen once by the faculties that run each tick, then get out of the way.
 */
export const PERCEPT_STALE_AFTER_TICKS = 2

/**
 * How much of a percept's `summary` survives.
 *
 * 100 because that is what `exteroception._summarizeEntity` has always used —
 * adopted rather than chosen, so naming it changes no behaviour. It is now one
 * constant instead of a literal per writer, which is the point: the sizing
 * question is real and open (SIGNAL_BOUNDARY §4 asks it of 120/300/700 too, and
 * notes that none of those was ever a budget decision), and answering it should
 * be a one-line change in one place rather than an archaeology exercise.
 */
export const PERCEPT_SUMMARY_CAP = 100

/** What every percept must say, whatever wrote it. */
export interface PerceptFacts {
  /** Deterministic and unique. Never `wallClock()` — this lives in state (R2). */
  id:         string
  /** The tick it arrived on. REQUIRED: without it the entity is never swept. */
  tick:       number
  /** 0–1. The rupture gate reads this. */
  salience:   number
  /** Coarse kind, for grouping — 'message-delivery', 'system', 'undertaking'… */
  category:   string
  /** The one field the executive prompt renders. If it is not here, it is unread. */
  summary:    string
  /** REQUIRED: untagged means unrupturable. See `SignalProvenance`. */
  provenance: SignalProvenance
  /** The intent this is the consequence of, when `provenance` is `'reafferent'`. */
  sourceIntentId?: string
  /** The world entity this is about, where there is one. */
  entityId?:      string
  /** What happened to it — 'delivered', 'removed', 'changed'… */
  changeType?:    string
  /** What it FELT like, and how much that says about it (registry #5). */
  valence?:       number
  valenceSource?: string
}

/** The write-side entity shape `stateManager.setEntity` accepts. */
export interface PerceptEntity {
  id:       string
  type:     typeof PERCEPT_TYPE
  metadata: Record<string, unknown>
}

/**
 * Build a `percept` entity. `extra` carries a writer's own fields (`messageId`,
 * `facetId`, `offlineMs`…) and cannot overwrite the core: a writer that could
 * clobber its own `tick` or `provenance` is back where it started.
 */
export function perceptEntity( facts: PerceptFacts, extra: Record<string, unknown> = {} ): PerceptEntity {
  return {
    id:   facts.id,
    type: PERCEPT_TYPE,
    metadata: {
      ...extra,
      tick:       facts.tick,
      salience:   facts.salience,
      category:   facts.category,
      summary:    facts.summary,
      provenance: facts.provenance,
      ...( facts.sourceIntentId !== undefined ? { sourceIntentId: facts.sourceIntentId } : {} ),
      ...( facts.entityId       !== undefined ? { entityId:       facts.entityId       } : {} ),
      ...( facts.changeType     !== undefined ? { changeType:     facts.changeType     } : {} ),
      ...( facts.valence        !== undefined ? { valence:        facts.valence        } : {} ),
      ...( facts.valenceSource  !== undefined ? { valenceSource:  facts.valenceSource  } : {} ),
    },
  }
}

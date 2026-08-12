// ─────────────────────────────────────────────────────────────
// src/cognition/sense.boundary.ts  —  where I end and the world begins
// ─────────────────────────────────────────────────────────────
//
// A body needs no rule saying "do not see your own premotor cortex." You do not
// see it because the retina sits ON the boundary and motor planning is inside
// it. Efference reaches you as a different signal, in a different modality,
// already marked as yours — which this engine knows: that is what EXAFFERENCE
// P1/P2 built.
//
// Will has no such boundary. Cognition and world share one `state.entities` map,
// so the mind's own bookkeeping sits in the same place as the things it is
// bookkeeping ABOUT, and Exteroception — the outward sense — walks the lot.
//
// THE COST, MEASURED. A mind booted offline for 300 quiet ticks — no host, no
// channel, nothing outside it at all — produced 36,721 percepts, every one about
// itself:
//
//     17802  removed            its own affordances being torn down each tick
//     16950  affordance         its own affordances being rebuilt each tick
//       546  calibration.state
//       496  agency.intent
//       287  agency.outcome
//       286  agency.skill
//       135  action.unresolved
//       120  engine.config      its own configuration
//        96  attention.demand
//         3  will.identity      its own identity entity
//
// `maxPerceptsPerTick` is 50. The affordance field alone churns ~116 entities a
// tick, so the sensory cap was consumed by self-noise before the world said
// anything — and nothing downstream filters by category, so working memory, the
// novelty detector, the attention allocator and episodic consolidation all ate
// it. The visible symptom was elsewhere: a fresh Will proceduralized `inspect`
// to habit 0.64 within fifteen ticks and spent five of its first eight decisions
// examining its own affordance entities, because a percept-bound act offered
// against phantom percepts is a real act aimed at nothing.
//
// WHY IT DRIFTED. The boundary was a denylist living inside the sense
// (`internalTypes`), correct for the faculties it shipped beside in v0.1.0 and
// silently wrong for every entity type invented after. `git log -L` on that
// block shows two edits in five weeks — EXAFFERENCE P2 and P4 — each adding the
// one agency type in front of its author at that moment. A hand-kept list is
// correct for whatever you were last thinking about.
//
// THE ASYMMETRY THAT MAKES THIS TRACTABLE. The mind's own types are a CLOSED
// set: it knows its own anatomy. The world's types are OPEN and unknowable —
// that is the whole point of a container anything can rent. So enumerate the
// self, and let everything else be world by default. Openness is preserved
// exactly where it must be: a host introduces any entity type, any shape, and
// the mind perceives it, with no act narrowed and no schema gated.
//
// Two sources, unioned:
//   • MIND_OWN_ENTITY_TYPES — the anatomy this package ships.
//   • each registered engine's `writes` — so a tenant that brings its OWN
//     cognitive engine declares its own machinery beside the code that writes
//     it, and gets this right without editing the container.
//
// The guard that keeps it true is behavioural, not a source scanner:
// `sense.boundary.test.ts` boots a mind into an empty world and asserts it
// perceives nothing. A new engine writing a new undeclared type fails it.
// ─────────────────────────────────────────────────────────────

import { CONSEQUENCE_TYPE } from '#agency/consequence'
import { REVOCATION_TYPE }  from '#agency/revocation'
import { SETTLEMENT_TYPE }  from '#agency/settlement'

/**
 * Entity types that ARE the mind — written by its own engines about its own
 * operation. Not perceptible: a mind does not encounter its own machinery as an
 * event in the world.
 *
 * Grouped by the faculty that writes them so a reader can check the list
 * against the anatomy. Everything absent here is world.
 */
export const MIND_OWN_ENTITY_TYPES: ReadonlySet<string> = new Set([
  // ── perception ────────────────────────────────────────────────
  // Percepts about percepts are the original feedback loop this guarded.
  'percept', 'percept.social',

  // ── attention, interoception, control ─────────────────────────
  'interoception', 'attention.focus', 'attention.demand',
  'task.focus', 'decision.record', 'self_observation',

  // ── memory ────────────────────────────────────────────────────
  'working_memory.item', 'episodic_memory', 'spaced_repetition_record',
  'belief', 'belief.integrate',

  // ── deliberative structure ────────────────────────────────────
  'goal', 'plan', 'plan.prior',

  // ── narrative + metacognition ─────────────────────────────────
  'narrative_chapter', 'introspection', 'self_narrative', 'cognitive_bias',
  'calibration.state', 'executive.summary', 'executive.cache',

  // ── affect + social models ────────────────────────────────────
  // A dossier is the mind's record OF someone, not the someone. The person
  // arrives through audition and social perception; the dossier is what the
  // mind then holds about them, and re-perceiving it double-counts.
  'affect.blends', 'empathic_state', 'attachment.bond',
  'theory_of_mind', 'reputation',
  'known-entity', 'known-entity-alias',

  // ── conversation records ──────────────────────────────────────
  // SocialPerception is the sense that owns these (it reads
  // `conversation.received` and emits `percept.social` from it, then sweeps it).
  // Exteroception perceiving them too was the same turn counted twice.
  'conversation.received', 'conversation.sent',

  // ── agency ────────────────────────────────────────────────────
  // The whole pipeline: the field it synthesizes, what it committed to, what
  // came back, what it learned, and what it merely imagined.
  'affordance', 'agency.intent', 'agency.outcome', 'agency.skill',
  'agency.schema', 'ideomotor.intent',
  'action.unresolved', 'action.unaddressed',
  CONSEQUENCE_TYPE,   // forward-model records  (EXAFFERENCE P1/P2)
  REVOCATION_TYPE,    // commitment tombstones  (EXAFFERENCE P4)
  SETTLEMENT_TYPE,    // verdicts System 2 reached — having thought about it

  // ── substrate ─────────────────────────────────────────────────
  // Its configuration and its identity are constitutive of it, not events in
  // its world. It had been perceiving both.
  'engine.config', 'will.identity', 'effector.created',
  'dream.activity',
])

/** An engine that declares the entity types it writes about the mind itself. */
export interface DeclaresWrites {
  /**
   * Entity types this engine writes as part of the mind's own operation.
   *
   * Declare here anything the mind should NOT re-encounter through its outward
   * senses. Omit it for engines that write about the WORLD — a host engine
   * maintaining rooms, documents, or sensor readings wants those perceived, and
   * silence is the right default for them.
   */
  readonly writes?: readonly string[]
}

/**
 * The full endogenous set for a given assembly: the shipped anatomy plus
 * whatever the registered engines declare.
 *
 * Cheap enough to call per tick, but Exteroception memoizes on the engine list
 * so a 50-engine union isn't rebuilt in the perceptual hot path.
 */
export function endogenousTypes( engines: readonly DeclaresWrites[] ): ReadonlySet<string> {
  let extra: Set<string> | null = null
  for( const e of engines )
    for( const t of e.writes ?? [] )
      if( !MIND_OWN_ENTITY_TYPES.has( t ) )
        ( extra ??= new Set() ).add( t )

  if( !extra ) return MIND_OWN_ENTITY_TYPES
  return new Set([ ...MIND_OWN_ENTITY_TYPES, ...extra ])
}

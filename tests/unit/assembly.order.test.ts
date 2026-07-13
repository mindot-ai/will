// ─────────────────────────────────────────────────────────────
// tests/unit/assembly.order.test.ts — the assembly as a reviewed artifact
// ─────────────────────────────────────────────────────────────
/**
 * Fixes-program item 2 (part 2): formalize the mind assembly.
 *
 * Two implicit, load-bearing facts become explicit, reviewed artifacts here:
 *
 * 1. ENGINE EXECUTION ORDER. Engines run strictly serially in registration
 *    order — that order IS replay determinism and correctness (the binder must
 *    tick after the senses, agency last). But the real order comes from
 *    `priority` fields scattered across ~40 engine files and a sort in
 *    mind.ts — visible nowhere. This test pins the exact per-tier order:
 *    changing any priority or tier gate produces a red diff that must be
 *    consciously accepted.
 *
 * 2. WIRING COMPLETENESS. The graph is wired by hand (`attachX()` calls); a
 *    forgotten attachment silently no-ops (the PlanningEngine.attachBus
 *    precedent). The audit (stem/assembly.audit.ts) reflects every attach
 *    point; this test pins the EXPECTED unwired set per tier (intentional
 *    tier gating + stem-side late wiring like sessionLogger/grants). A newly
 *    added engine whose wiring was forgotten shows up as an unexpected entry.
 *
 * When this test goes red on purpose, update the snapshot in the same diff —
 * that IS the formalization: assembly changes become reviewable artifacts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { assembleMind } from '#stem/mind'
import type { WillConfig, Anatomy } from '#stem/mind'
import { auditAssemblyWiring, wiringKeys } from '#stem/assembly.audit'
import { setLogger, resetLogger } from '#core/logger'

function makeConfig( anatomy: Anatomy ): WillConfig {
  return {
    id: `assembly-${anatomy}`, name: 'A', profile: null,
    identity: { prompt: 'assembly probe', values: [ 'x' ], traits: {}, style: 'x' },
    anatomy,
    persistentMemory: false, snapshotInterval: 999_999, tickIntervalMs: 0,
    randomSeed: 1, executiveInterval: 50, testMode: true,
    clock: { fixedDeltaMs: 1000, startTime: 0 },
  }
}

// ── The pinned execution orders (registration = serial tick order) ──

const CORE_ORDER = [
  'token-tracker',
  'energy-regulator', 'sleep-pressure-regulator', 'circadian-oscillator',
  'attention-allocator', 'stress-regulator',
  'exteroception', 'interoception', 'social-perception', 'novelty-detector',
  'working-memory', 'episodic-consolidator', 'semantic-integrator',
  'spaced-repetition', 'forgetting-curve', 'dream-simulator',
  'goal-manager', 'planning-engine', 'inhibition-controller', 'task-switcher',
  'instruction-intake',
]

const AFFECTIVE_ORDER = [
  'threat-evaluator', 'reward-evaluator', 'loss-evaluator',
  'frustration-evaluator', 'attachment-evaluator', 'aesthetic-evaluator',
  'moral-evaluator', 'affective-blender',
]

// Narrator + introspection are executive SATELLITES (they harvest the
// executive's own NARRATIVE/INTROSPECTION output; no LLM calls of their own)
// — they register wherever the executive runs (standard+), directly after it.
const EXEC_SATELLITE_ORDER = [
  'autobiographical-narrator', 'introspection-engine',
]

const META_SOCIAL_ORDER = [
  'self-model-updater', 'confidence-calibrator', 'bias-detector',
  'persona-consolidator',
  'theory-of-mind', 'empathy-simulator', 'reputation-tracker',
]

const SENSE_ORDER = [
  'audition-engine', 'vision-engine', 'somatosensation-engine',
  'olfaction-engine', 'gustation-engine',
]

// Agency ticks LAST — after perception + known-entity — so the field it
// synthesizes reflects this tick's percepts and dossiers.
const AGENCY_ORDER = [
  'affordance-synthesizer', 'action-selector', 'deliberation',
  'motor-schema-executor', 'reafference',
]

// Two anatomies only: 'reflex' (no-LLM shell) and 'mind' (everything).
// There is deliberately nothing in between — faculties are not a tier axis.
const EXPECTED_ORDER: Record<Anatomy, string[]> = {
  reflex: [
    ...CORE_ORDER,
    ...SENSE_ORDER,
    ...AGENCY_ORDER,
  ],
  mind: [
    ...CORE_ORDER,
    ...AFFECTIVE_ORDER,
    'executive-engine',
    ...EXEC_SATELLITE_ORDER,
    ...META_SOCIAL_ORDER,
    ...SENSE_ORDER,
    'known-entity-tracker',
    ...AGENCY_ORDER,
  ],
}

// ── The pinned expected-unwired sets (intentional gating + late wiring) ──
//
// sessionLogger / grants / reply callbacks attach in the STEM after assembly
// (WillStem.createWill); executive attachments are tier-gated off at basic.
// Anything appearing here that isn't in these lists = a forgotten attachment.

const LATE_WIRED_ALWAYS = [
  'affordance-synthesizer.attachSkills',
  'audition-engine.attachReplyCallback',
  'goal-manager.attachSessionLogger',
  'gustation-engine.attachGrants',
  'olfaction-engine.attachGrants',
  'planning-engine.attachSessionLogger',
  'semantic-integrator.attachSemanticClustering',
  'semantic-integrator.attachSessionLogger',
  'somatosensation-engine.attachGrants',
  'spaced-repetition.attachSessionLogger',
  'vision-engine.attachGrants',
]

const EXPECTED_UNWIRED: Record<Anatomy, string[]> = {
  // reflex: no System 2 — the executive attachments stay off (documented).
  reflex: [
    ...LATE_WIRED_ALWAYS,
    'audition-engine.attachExecutiveEngine',
    'planning-engine.attachExecutiveEngine',
  ].sort(),
  mind: [
    ...LATE_WIRED_ALWAYS,
    'executive-engine.attachSessionLogger',
  ].sort(),
}

describe( 'mind assembly — order + wiring as reviewed artifacts', () => {
  beforeAll( () => setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: console.error } ) )
  afterAll( () => resetLogger() )

  for( const anatomy of [ 'reflex', 'mind' ] as Anatomy[] ){
    it( `${anatomy}: engine execution order matches the pinned artifact`, () => {
      const { simulation } = assembleMind( `assembly-${anatomy}`, makeConfig( anatomy ) )
      expect( simulation.orchestrator.engineNames ).toEqual( EXPECTED_ORDER[ anatomy ] )
    } )

    it( `${anatomy}: no attachment is unwired beyond the pinned expected set`, () => {
      const { simulation } = assembleMind( `assembly-audit-${anatomy}`, makeConfig( anatomy ) )
      const audit = auditAssemblyWiring( simulation.orchestrator.engines )
      expect( wiringKeys( audit, 'unwired' ) ).toEqual( EXPECTED_UNWIRED[ anatomy ] )
    } )
  }

  it( 'threads config.model to the executive as a concrete id (env pin wins)', () => {
    const saved = process.env['WILL_LLM_MODEL']
    delete process.env['WILL_LLM_MODEL']
    try {
      const { cognition } = assembleMind( 'assembly-model', {
        ...makeConfig('mind'), id: 'assembly-model', model: 'test-model-id',
      } )
      expect( cognition.executiveEngine.modelId ).toBe( 'test-model-id' )

      // Per-role map: summarizer diverges, deliberation falls back to executive.
      const { cognition: c3 } = assembleMind( 'assembly-model-3', {
        ...makeConfig('mind'), id: 'assembly-model-3',
        model: { executive: 'big-model', summarizer: 'small-model' },
      } )
      expect( c3.executiveEngine.models ).toEqual( {
        executive: 'big-model', summarizer: 'small-model', deliberation: 'big-model', conversation: 'big-model',
      } )

      process.env['WILL_LLM_MODEL'] = 'operator-pin'
      const { cognition: c2 } = assembleMind( 'assembly-model-2', {
        ...makeConfig('mind'), id: 'assembly-model-2', model: 'test-model-id',
      } )
      expect( c2.executiveEngine.modelId ).toBe( 'operator-pin' )
    } finally {
      if( saved === undefined ) delete process.env['WILL_LLM_MODEL']
      else process.env['WILL_LLM_MODEL'] = saved
    }
  } )
} )

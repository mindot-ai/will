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
import type { WillConfig, EngineTier } from '#stem/mind'
import { auditAssemblyWiring, wiringKeys } from '#stem/assembly.audit'
import { setLogger, resetLogger } from '#core/logger'

function makeConfig( tier: EngineTier ): WillConfig {
  return {
    id: `assembly-${tier}`, name: 'A', profile: null,
    identity: { prompt: 'assembly probe', values: [ 'x' ], traits: {}, style: 'x' },
    engineTier: tier, modelTier: 'haiku',
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

const META_SOCIAL_ORDER = [
  'self-model-updater', 'confidence-calibrator', 'bias-detector',
  'autobiographical-narrator', 'introspection-engine', 'persona-consolidator',
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

const EXPECTED_ORDER: Record<EngineTier, string[]> = {
  basic: [
    ...CORE_ORDER,
    ...SENSE_ORDER,
    ...AGENCY_ORDER,
  ],
  standard: [
    ...CORE_ORDER,
    ...AFFECTIVE_ORDER,
    'executive-engine',
    ...SENSE_ORDER,
    'known-entity-tracker',
    ...AGENCY_ORDER,
  ],
  full: [
    ...CORE_ORDER,
    ...AFFECTIVE_ORDER,
    'executive-engine',
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

const EXPECTED_UNWIRED: Record<EngineTier, string[]> = {
  // basic: the executive tier-gates off planning + audition (documented).
  basic: [
    ...LATE_WIRED_ALWAYS,
    'audition-engine.attachExecutiveEngine',
    'planning-engine.attachExecutiveEngine',
  ].sort(),
  standard: [
    ...LATE_WIRED_ALWAYS,
    'executive-engine.attachSessionLogger',
  ].sort(),
  full: [
    ...LATE_WIRED_ALWAYS,
    'executive-engine.attachSessionLogger',
  ].sort(),
}

describe( 'mind assembly — order + wiring as reviewed artifacts', () => {
  beforeAll( () => setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: console.error } ) )
  afterAll( () => resetLogger() )

  for( const tier of [ 'basic', 'standard', 'full' ] as EngineTier[] ){
    it( `${tier}: engine execution order matches the pinned artifact`, () => {
      const { simulation } = assembleMind( `assembly-${tier}`, makeConfig( tier ) )
      expect( simulation.orchestrator.engineNames ).toEqual( EXPECTED_ORDER[ tier ] )
    } )

    it( `${tier}: no attachment is unwired beyond the pinned expected set`, () => {
      const { simulation } = assembleMind( `assembly-audit-${tier}`, makeConfig( tier ) )
      const audit = auditAssemblyWiring( simulation.orchestrator.engines )
      expect( wiringKeys( audit, 'unwired' ) ).toEqual( EXPECTED_UNWIRED[ tier ] )
    } )
  }
} )

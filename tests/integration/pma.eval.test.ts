// ─────────────────────────────────────────────────────────────
// tests/integration/pma.eval.test.ts
// ─────────────────────────────────────────────────────────────
//
// PMA (Persistent Mind Artifact) reconstruction fidelity test suite.
//
// Phase 1 (structural) always runs — no LLM needed.
// Phase 2 (behavioral probes) is skipped unless WILL_LLM_TEST=1 is set.
//
// Run with:
//   vitest run tests/integration/pma.eval.test.ts
//   WILL_LLM_TEST=1 vitest run tests/integration/pma.eval.test.ts
// ─────────────────────────────────────────────────────────────

import { assembleMind, type WillConfig } from '#stem/mind'
import type { PMASnapshot } from '#pma/index'
import { PMA_SCHEMA_VERSION, PMALoader, PMADistiller } from '#pma/index'
import { describe, it, expect } from 'vitest'
import { PMAEvalHarness, STANDARD_PROBES } from '#pma/eval'

// ── Minimal Will config for testing ───────────────────────────

const BASE_CONFIG: Omit<WillConfig, 'id'> = {
  name:             'TestWill',
  engineTier:       'basic',   // no LLM — fast + deterministic
  modelTier:        'haiku',
  persistentMemory: false,
  snapshotInterval: 999999,
  tickIntervalMs:   0,
  maxTicks:         0,
  identity: {
    prompt: 'Test Will for PMA evaluation.',
    values: [ 'curiosity', 'honesty' ],
    style:  'concise',
    traits: { openness: 0.8, conscientiousness: 0.6 },
  },
}

// ── Fixture: a realistic PMASnapshot (enhanced with all fields) ──

function makePMA(): PMASnapshot {
  return {
    schemaVersion:   PMA_SCHEMA_VERSION,
    willId:          'test-will-pma',
    willName:        'TestWill',
    distilledAt:     Date.now(),
    sourceSessionId: 'session-fixture-001',

    identity: {
      prompt:  'I am a curious and honest assistant.',
      values:  [ 'curiosity', 'honesty', 'growth' ],
      traits:  { openness: 0.80, conscientiousness: 0.60, agreeableness: 0.55 },
      // Per-trait self-knowledge (graded salience B/C) — the Will's own norm + recency.
      traitStats: {
        openness:          { mean: 0.62, shiftDir:  1, shiftTick: 1200 },
        conscientiousness: { mean: 0.58, shiftDir:  0, shiftTick: 0    },
      },
      style:   'concise and direct',
      version: 3,
      // Enhanced identity fields
      socialOrientation: 'ambivert',
      trustPropensity:   0.65,
      memoryPersistence: 0.70,
    },

    beliefs: [
      {
        id:                 'belief-world-complex',
        statement:          'The world is complex and requires careful reasoning.',
        category:           'world_fact',
        confidence:         0.75,
        supportingEpisodes: 12,
        tags:               [ 'reasoning', 'complexity' ],
        history:            [
          { tick: 10, confidence: 0.60, delta: 0.60, cause: 'executive'   },
          { tick: 50, confidence: 0.75, delta: 0.15, cause: 'reinforced'  },
        ],
      },
      {
        id:                 'belief-self-learning',
        statement:          'I am effective at learning tasks.',
        category:           'self_belief',
        confidence:         0.65,
        supportingEpisodes: 8,
        tags:               [ 'learning', 'competence', 'self', 'positive' ],
        history:            [
          { tick: 30, confidence: 0.65, delta: 0.65, cause: 'self-model' },
        ],
      },
    ],

    goals: [
      {
        id:                  'goal-1',
        description:         'Deepen understanding of the simulation domain',
        priority:            0.7,
        progress:            0.3,
        status:              'active',
        tags:                [ 'learning', 'growth' ],
        completionType:      'epistemic',
        completionCondition: undefined,
      },
    ],

    emotionalBaseline: {
      dominantMood:        'neutral',
      avgValence:          0.10,
      arousalProfile:      'moderate',
      avgSpikeFrequency:   1.2,
      // Enhanced emotional fields
      temperamentValence:  0.15,  // slightly optimistic baseline
      reactivity:          0.55,  // moderate emotional responsiveness
    },

    behavioral: {
      topActions:          [ 'reflect', 'learn', 'explore' ],
      avgConfidence:       0.62,
      completionRate:      0.25,
      // Enhanced behavioral fields
      riskTolerance:       0.45,  // slightly risk-averse
      explorationRate:     0.35,  // moderate novelty-seeking
      impulsivity:         0.28,  // fairly deliberate
    },

    relationships: [
      {
        keid:   'user-alice',
        agentName: 'Alice',
        attachment: {
          attachmentStrength: 0.65,
          trustLevel:         0.70,
          positiveRatio:      0.80,
          interactionCount:   24,
          sharedExperiences:  8,
          dependency:         0.20,
        },
        reputation: {
          reliability:          0.72,
          cooperativeness:      0.75,
          socialStanding:       0.60,
          trustworthiness:      0.71,
          interactionCount:     24,
          positiveInteractions: 19,
          negativeInteractions: 3,
          confidence:           0.68,
        },
        mentalModel: {
          modelConfidence:   0.66,
          dominantIntention: 'collaborate',
          estimatedEmotion:  'satisfaction',
        },
        dossier: {
          kind:                 'sentient',
          name:                 'Alice',
          familiarity:          0.55,
          valence:              0.4,
          reliability:          0.7,
          encounterCount:       18,
          resolutionConfidence: 0.6,
        },
      },
    ],

    episodicCount: 45,

    meta: {
      beliefCount:         2,
      goalCount:           1,
      relationshipCount:   1,
      sessionSummaryCount: 3,
    },
  }
}

// ── Tests ──────────────────────────────────────────────────────

describe('PMA Reconstruction Fidelity', () => {
  const harness = new PMAEvalHarness()

  it('evaluates structural fidelity of a well-formed PMA', async () => {
    const pma    = makePMA()
    const report = await harness.evaluate( pma, BASE_CONFIG )

    // All component scores should be above 0
    expect( report.scores.beliefs           ).toBeGreaterThan( 0 )
    expect( report.scores.goals             ).toBeGreaterThan( 0 )
    expect( report.scores.identity          ).toBeGreaterThan( 0 )
    expect( report.scores.emotionalBaseline ).toBeGreaterThan( 0 )
    expect( report.scores.overall           ).toBeGreaterThan( 0 )

    // Provenance
    expect( report.willId       ).toBe( 'test-will-pma'     )
    expect( report.pmaVersion   ).toBe( PMA_SCHEMA_VERSION  )
    expect( report.behavioralProbesRan    ).toBe( false )
    expect( report.behavioralProbeResult  ).toBeNull()
  })

  it('achieves high belief fidelity when beliefs are exactly loaded', async () => {
    const pma    = makePMA()
    const report = await harness.evaluate( pma, BASE_CONFIG )

    // Both beliefs should be recovered (PMALoader injects them via integrateExecutiveBelief)
    expect( report.details.beliefs.total     ).toBe( 2 )
    expect( report.details.beliefs.recovered ).toBe( 2 )
    expect( report.details.beliefs.missing   ).toHaveLength( 0 )
    expect( report.details.beliefs.fidelityScore ).toBe( 1 )
  })

  it('achieves high goal fidelity when goals are exactly loaded', async () => {
    const pma    = makePMA()
    const report = await harness.evaluate( pma, BASE_CONFIG )

    expect( report.details.goals.total     ).toBe( 1 )
    expect( report.details.goals.recovered ).toBe( 1 )
    expect( report.details.goals.fidelityScore ).toBe( 1 )
  })

  it('achieves near-perfect identity fidelity for identical trait vectors', async () => {
    const pma    = makePMA()
    const report = await harness.evaluate( pma, BASE_CONFIG )

    // Cosine similarity of identical vectors = 1
    expect( report.details.identity.cosineSimilarity ).toBeCloseTo( 1, 2 )
    expect( report.details.identity.fidelityScore    ).toBeCloseTo( 1, 2 )
  })

  it('preserves enhanced identity fields (socialOrientation, trustPropensity, memoryPersistence)', async () => {
    const pma = makePMA()
    const { simulation, cognition: _cog } = assembleMind( `identity-test-${Date.now()}`, {
      ...BASE_CONFIG as any,
      id: `identity-test-${Date.now()}`,
      persistentMemory: false,
    })

    new PMALoader().load( pma, simulation, _cog )
    const state = simulation.stateManager.snapshot()

    const identityEntity = [ ...state.entities.values() ].find( e => e.type === 'will.identity' )
    expect( identityEntity ).toBeDefined()
    expect( identityEntity?.metadata?.['socialOrientation'] ).toBe( 'ambivert' )
    expect( identityEntity?.metadata?.['trustPropensity']   ).toBeCloseTo( 0.65, 2 )
    expect( identityEntity?.metadata?.['memoryPersistence'] ).toBeCloseTo( 0.70, 2 )
  })

  it('persists traitStats (graded-salience personal norm) across a distill→load round-trip', () => {
    const pma = makePMA()
    const { simulation, cognition: _cog } = assembleMind( `traitstats-test-${Date.now()}`, {
      ...BASE_CONFIG as any,
      id: `traitstats-test-${Date.now()}`,
      persistentMemory: false,
    })

    // load restores the Will's own norm onto identity-self …
    new PMALoader().load( pma, simulation, _cog )
    const state = simulation.stateManager.snapshot()
    const identityEntity = [ ...state.entities.values() ].find( e => e.type === 'will.identity' )
    expect( identityEntity?.metadata?.['traitStats'] ).toEqual( pma.identity.traitStats )

    // … and distill reads it back out (extract + enhance spread) — a clean round-trip.
    const redistilled = new PMADistiller().distill( pma.willId, pma.willName, state, 'session-roundtrip' )
    expect( redistilled.identity.traitStats ).toEqual( pma.identity.traitStats )
  })

  it('preserves enhanced emotional baseline fields (temperamentValence, reactivity)', async () => {
    const pma = makePMA()
    const { simulation, cognition: _cog } = assembleMind( `emotional-test-${Date.now()}`, {
      ...BASE_CONFIG as any,
      id: `emotional-test-${Date.now()}`,
      persistentMemory: false,
    })

    new PMALoader().load( pma, simulation, _cog )
    const state = simulation.stateManager.snapshot()

    // Temperament should be stored as engine config for affective blender
    const affectiveConfig = [ ...state.entities.values() ].find( e =>
      e.type === 'engine.config' && e.metadata?.['engine'] === 'affective-blender'
    )
    expect( affectiveConfig ).toBeDefined()
    const affectiveParams = affectiveConfig?.metadata?.['params'] as Record<string, number> | undefined
    expect( affectiveParams?.['temperamentValence'] ).toBeCloseTo( 0.15, 2 )
    expect( affectiveParams?.['inertia'] ).toBeCloseTo( 0.45, 2 ) // 1 - reactivity
  })

  it('preserves enhanced behavioral fields (riskTolerance, explorationRate, impulsivity)', async () => {
    const pma = makePMA()
    const { simulation, cognition: _cog } = assembleMind( `behavioral-test-${Date.now()}`, {
      ...BASE_CONFIG as any,
      id: `behavioral-test-${Date.now()}`,
      persistentMemory: false,
    })

    new PMALoader().load( pma, simulation, _cog )
    const state = simulation.stateManager.snapshot()

    // Behavioral parameters should be stored as engine config for executive
    const executiveConfig = [ ...state.entities.values() ].find( e =>
      e.type === 'engine.config' && e.metadata?.['engine'] === 'executive'
    )
    expect( executiveConfig ).toBeDefined()
    const executiveParams = executiveConfig?.metadata?.['params'] as Record<string, number> | undefined
    expect( executiveParams?.['riskTolerance']   ).toBeCloseTo( 0.45, 2 )
    expect( executiveParams?.['explorationRate'] ).toBeCloseTo( 0.35, 2 )
    expect( executiveParams?.['impulsivity']     ).toBeCloseTo( 0.28, 2 )
  })

  it('preserves memory persistence as forgetting curve configuration', async () => {
    const pma = makePMA()
    const { simulation, cognition: _cog } = assembleMind( `memory-test-${Date.now()}`, {
      ...BASE_CONFIG as any,
      id: `memory-test-${Date.now()}`,
      persistentMemory: false,
    })

    new PMALoader().load( pma, simulation, _cog )
    const state = simulation.stateManager.snapshot()

    const forgettingConfig = [ ...state.entities.values() ].find( e =>
      e.type === 'engine.config' && e.metadata?.['engine'] === 'forgetting-curve'
    )
    expect( forgettingConfig ).toBeDefined()
    // memoryPersistence 0.70 → baseForgettingRate = 1 - (0.70 * 0.7) = 0.51
    const expectedRate    = 1 - (0.70 * 0.7)
    const forgettingParams = forgettingConfig?.metadata?.['params'] as Record<string, number> | undefined
    expect( forgettingParams?.['baseForgettingRate'] ).toBeCloseTo( expectedRate, 2 )
  })

  it('achieves reasonable emotional baseline fidelity', async () => {
    const pma    = makePMA()
    const report = await harness.evaluate( pma, BASE_CONFIG )

    // Loader sets valence = avgValence (0.10) and arousal = moderate (0.45)
    // Expected arousal = 0.45, loaded = 0.45 → delta = 0
    // Expected valence = 0.10, loaded = 0.10 → delta = 0
    expect( report.details.emotionalBaseline.valenceDelta ).toBeCloseTo( 0, 3 )
    expect( report.details.emotionalBaseline.arousalDelta ).toBeCloseTo( 0, 3 )
    expect( report.details.emotionalBaseline.fidelityScore ).toBeCloseTo( 1, 2 )
  })

  it('overall score exceeds 0.85 for a clean round-trip', async () => {
    const pma    = makePMA()
    const report = await harness.evaluate( pma, BASE_CONFIG )

    expect( report.scores.overall ).toBeGreaterThanOrEqual( 0.85 )
  })

  it('reports zero belief fidelity for an empty PMA', async () => {
    const pma = makePMA()
    pma.beliefs = []
    pma.meta.beliefCount = 0

    const report = await harness.evaluate( pma, BASE_CONFIG )

    // No beliefs to recover → perfect fidelity by definition
    expect( report.details.beliefs.fidelityScore ).toBe( 1 )
    expect( report.details.beliefs.total          ).toBe( 0 )
  })

  it('relationship stubs are seeded as state entities that engines can restore from', async () => {
    const pma = makePMA()
    const { simulation, cognition: _cog } = assembleMind( `rel-test-${Date.now()}`, {
      ...BASE_CONFIG as any,
      id: `rel-test-${Date.now()}`,
      persistentMemory: false,
    })

    new PMALoader().load( pma, simulation, _cog )

    const state = simulation.stateManager.snapshot()

    // attachment.bond entity should exist for user-alice
    const bondEntity = [ ...state.entities.values() ].find( e =>
      e.type === 'attachment.bond' && e.metadata?.['keid'] === 'user-alice'
    )
    expect( bondEntity ).toBeDefined()
    expect( bondEntity?.metadata?.['strength'] ).toBeCloseTo( 0.65, 2 )
    expect( bondEntity?.metadata?.['trust']    ).toBeCloseTo( 0.70, 2 )

    // reputation entity should exist for user-alice
    const repEntity = [ ...state.entities.values() ].find( e =>
      e.type === 'reputation' && e.metadata?.['keid'] === 'user-alice'
    )
    expect( repEntity ).toBeDefined()
    expect( repEntity?.metadata?.['reliability']    ).toBeCloseTo( 0.72, 2 )
    expect( repEntity?.metadata?.['trustworthiness'] ).toBeCloseTo( 0.71, 2 )
    expect( repEntity?.metadata?.['name']           ).toBe( 'Alice' )

    // theory-of-mind gist should be re-seeded (Phase 0) so the Will can model alex's mind again
    const tomEntity = [ ...state.entities.values() ].find( e =>
      e.type === 'theory_of_mind' && e.metadata?.['keid'] === 'user-alice'
    )
    expect( tomEntity ).toBeDefined()
    expect( tomEntity?.metadata?.['modelConfidence']   ).toBeCloseTo( 0.66, 2 )
    expect( tomEntity?.metadata?.['dominantIntention'] ).toBe( 'collaborate' )

    // known-entity dossier should be re-seeded (Phase 2.3) so "I remember you" survives a restart
    const keEntity = [ ...state.entities.values() ].find( e =>
      e.type === 'known-entity' && e.metadata?.['keid'] === 'user-alice'
    )
    expect( keEntity ).toBeDefined()
    expect( keEntity?.metadata?.['name'] ).toBe( 'Alice' )
    expect( keEntity?.metadata?.['familiarity'] ).toBeCloseTo( 0.55, 2 )
    expect( keEntity?.metadata?.['reliability'] ).toBeCloseTo( 0.7, 2 )   // track-record carries (Phase 4)
    expect( keEntity?.metadata?.['lastSeenTick'] ).toBe( 0 )   // fresh embodiment
  })

  it('round-trips the theory-of-mind gist + known-entity dossier through distill → load → distill', () => {
    const pma = makePMA()
    const { simulation, cognition: _cog } = assembleMind( `tom-rt-${Date.now()}`, {
      ...BASE_CONFIG as any, id: `tom-rt-${Date.now()}`, persistentMemory: false,
    })
    new PMALoader().load( pma, simulation, _cog )
    const state = simulation.stateManager.snapshot()

    const redistilled = new PMADistiller().distill( pma.willId, pma.willName, state, 'session-tom-rt' )
    const rel = redistilled.relationships.find( r => r.keid === 'user-alice' )
    expect( rel?.mentalModel ).toEqual( pma.relationships[0]!.mentalModel )
    // lastSeenTick is intentionally reset on load (not persisted), so compare the rest.
    expect( rel?.dossier ).toEqual( pma.relationships[0]!.dossier )
  })

  it('persona (config priors + calibration) is seeded as state entities on load', async () => {
    const pma = makePMA()
    pma.persona = {
      configPriors:    { 'engine-config-self-model': { minIntervalTicks: -30 } },
      calibrationBias: { planning: 0.4 },
    }
    const id = `persona-load-${Date.now()}`
    const { simulation, cognition: _cog } = assembleMind( id, { ...( BASE_CONFIG as any ), id, persistentMemory: false } )

    new PMALoader().load( pma, simulation, _cog )
    const state = simulation.stateManager.snapshot()

    const prior = state.entities.get( 'persona-prior' )
    expect( prior?.metadata?.['priors'] ).toEqual({ 'engine-config-self-model': { minIntervalTicks: -30 } })

    const calib = state.entities.get( 'calibration-state' )
    expect( ( calib?.metadata?.['domainBias'] as Record<string, number> ).planning ).toBeCloseTo( 0.4, 5 )
  })

  it('distill round-trips the persona from state entities', async () => {
    const id = `persona-distill-${Date.now()}`
    const { simulation } = assembleMind( id, { ...( BASE_CONFIG as any ), id, persistentMemory: false } )
    const sm = simulation.stateManager
    sm.setEntity({ id: 'persona-prior', type: 'persona.prior', createdAt: 0, updatedAt: 0,
      metadata: { priors: { 'engine-config-narrator': { minIntervalTicks: -7.5 } }, version: 3, updatedAtTick: 100 } } as any )
    sm.setEntity({ id: 'calibration-state', type: 'calibration.state', createdAt: 0, updatedAt: 0,
      metadata: { domainBias: { social: 0.2 }, updatedAtTick: 100 } } as any )

    const pma = new PMADistiller().distill( id, 'TestWill', sm.snapshot(), 'sess', '/nonexistent-dir' )
    expect( pma.persona?.configPriors ).toEqual({ 'engine-config-narrator': { minIntervalTicks: -7.5 } })
    expect( pma.persona?.calibrationBias ).toEqual({ social: 0.2 })
  })

  it('omits persona when nothing has been learned', async () => {
    const id = `persona-empty-${Date.now()}`
    const { simulation } = assembleMind( id, { ...( BASE_CONFIG as any ), id, persistentMemory: false } )
    const pma = new PMADistiller().distill( id, 'TestWill', simulation.stateManager.snapshot(), 'sess', '/nonexistent-dir' )
    expect( pma.persona ).toBeUndefined()
  })

  it('reports identity degradation when loaded traits differ', async () => {
    const pma = makePMA()

    // Corrupt the identity traits to all-zeros — cosine similarity should drop
    pma.identity.traits = { openness: 0, conscientiousness: 0, agreeableness: 0 }

    const report = await harness.evaluate( pma, BASE_CONFIG )

    // The loaded simulation seeds zero traits → cosine similarity of zero-vector = 0
    expect( report.details.identity.cosineSimilarity ).toBe( 0 )
    expect( report.details.identity.fidelityScore    ).toBe( 0 )
  })

  it('standard probe suite has all required probe IDs', () => {
    const ids = STANDARD_PROBES.map( p => p.id )
    expect( ids ).toContain( 'low_energy_high_stress'   )
    expect( ids ).toContain( 'high_energy_positive_mood' )
    expect( ids ).toContain( 'goal_blocked'             )
    expect( ids ).toContain( 'neutral_baseline'         )
  })

  // ── Enhanced field round-trip tests ─────────────────────────

  it('preserves socialOrientation through distiller from identity traits', async () => {
    // This tests that if socialOrientation is not explicitly set, the distiller
    // infers it from behavioral patterns
    const pma = makePMA()
    // Remove explicit socialOrientation to test inference
    delete pma.identity.socialOrientation

    const report = await harness.evaluate( pma, BASE_CONFIG )

    // The distiller should infer socialOrientation from topActions
    // With topActions ['reflect', 'learn', 'explore'] → should infer 'reserved' or 'ambivert'
    expect( report.scores.overall ).toBeGreaterThanOrEqual( 0.8 )
  })

  it('preserves trustPropensity through distiller from completion rate', async () => {
    const pma = makePMA()
    // Remove explicit trustPropensity to test inference
    delete pma.identity.trustPropensity
    pma.behavioral.completionRate = 0.75  // High completion rate → higher trust propensity

    const report = await harness.evaluate( pma, BASE_CONFIG )

    expect( report.scores.overall ).toBeGreaterThanOrEqual( 0.8 )
  })

  // Phase 2: behavioral probes (requires LLM — skipped in CI by default)
  it.skipIf( !process.env['WILL_LLM_TEST'] )(
    'behavioral probes return non-null result when WILL_LLM_TEST=1',
    async () => {
      const pma    = makePMA()
      const report = await harness.evaluate( pma, {
        ...BASE_CONFIG,
        engineTier: 'standard',  // need executive engine for LLM cycles
      }, { runBehavioralProbes: true } )

      expect( report.behavioralProbesRan ).toBe( true )
      expect( report.behavioralProbeResult ).not.toBeNull()
      expect( report.behavioralProbeResult!.probeCount ).toBe( STANDARD_PROBES.length )
      expect( report.behavioralProbeResult!.distributionSimilarity ).toBeGreaterThanOrEqual( 0 )
    }
  )
})
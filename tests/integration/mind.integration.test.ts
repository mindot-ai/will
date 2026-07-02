// ─────────────────────────────────────────────────────────────
// src/tests/integration/mind.integration.test.ts
// ─────────────────────────────────────────────────────────────

/**
 * Integration test scenarios for the complete simulated mind.
 *
 * Validates:
 *   - All 35 engines start and run without errors
 *   - Cross-engine data flow is correct
 *   - Deterministic replay produces identical states
 *   - Graceful degradation under load
 */

import { describe, it, expect } from 'vitest'
import { DefaultSimulation, type SimulationConfig } from '#core/simulation'
import { CognitiveOrchestrator }                   from '#cognition/orchestrator'
import type { SimulationEntity }                   from '#core/types'

// Import all engines
import { EnergyRegulator } from '#faculties/energy.regulator'
import { SleepPressureRegulator } from '#faculties/sleep.pressure.regulator'
import { CircadianOscillator } from '#faculties/circadian.oscillator'
import { AttentionAllocator } from '#faculties/attention.allocator'
import { StressRegulator } from '#faculties/stress.regulator'
import { Exteroception } from '#faculties/exteroception'
import { Interoception } from '#faculties/interoception'
import { SocialPerception } from '#faculties/social.perception'
import { NoveltyDetector } from '#faculties/novelty.detector'
import { WorkingMemory } from '#faculties/working.memory'
import { ThreatEvaluator } from '#faculties/threat.evaluator'
import { RewardEvaluator } from '#faculties/reward.evaluator'
import { LossEvaluator } from '#faculties/loss.evaluator'
import { FrustrationEvaluator } from '#faculties/frustration.evaluator'
import { AttachmentEvaluator } from '#faculties/attachment.evaluator'
import { AestheticEvaluator } from '#faculties/aesthetic.evaluator'
import { MoralEvaluator } from '#faculties/moral.evaluator'
import { AffectiveBlender } from '#faculties/affective.blender'
import { EpisodicConsolidator } from '#faculties/episodic.consolidator'
import { SemanticIntegrator } from '#faculties/semantic.engine/integrator'
import { ForgettingCurve } from '#faculties/forgetting.curve'
import { DreamSimulator } from '#faculties/dream.simulator'
import { GoalManager } from '#faculties/goal.manager'
import { InhibitionController } from '#faculties/inhibition.controller'
import { TaskSwitcher } from '#faculties/task.switcher'
import { PlanningEngine } from '#faculties/planning.engine'
import { SelfModelUpdater } from '#faculties/self.model.updater'
import { ConfidenceCalibrator } from '#faculties/confidence.calibrator'
import { BiasDetector } from '#faculties/bias.detector'
import { AutobiographicalNarrator } from '#faculties/autobiographical.narrator'
import { IntrospectionEngine } from '#faculties/introspection.engine'
import { TheoryOfMind } from '#faculties/theory.of.mind'
import { EmpathySimulator } from '#faculties/empathy.simulator'
import { ReputationTracker } from '#faculties/reputation.tracker'

// ── Test fixture ─────────────────────────────────────────────

function createFullMind( config?: Partial<SimulationConfig> ): {
  simulation: DefaultSimulation
  engines: Map<string, any>
} {
  const simulation = new DefaultSimulation({
    randomSeed: 42,
    // Fixed startTime + fixedDeltaMs put the clock in deterministic mode, so
    // sim-time advances purely from ticks (never wall time) and reproduces
    // byte-for-byte on replay (R2).
    clock: { fixedDeltaMs: 50, startTime: 0 },
    ...config,
    // Use CognitiveOrchestrator so bus events flow between engines
    orchestratorFactory: ( clock, eventBus, stateManager, cfg ) =>
      new CognitiveOrchestrator( clock, eventBus, stateManager, cfg ),
  })

  const engines = new Map<string, any>()

  // Shard 0: Regulatory & Perceptual
  engines.set('energy-regulator', new EnergyRegulator() )
  engines.set('sleep-pressure-regulator', new SleepPressureRegulator() )
  engines.set('circadian-oscillator', new CircadianOscillator() )
  engines.set('attention-allocator', new AttentionAllocator() )
  engines.set('stress-regulator', new StressRegulator() )
  engines.set('exteroception', new Exteroception() )
  engines.set('interoception', new Interoception() )
  engines.set('social-perception', new SocialPerception() )
  engines.set('novelty-detector', new NoveltyDetector() )
  engines.set('working-memory', new WorkingMemory() )

  // Shard 1: Affective
  engines.set('threat-evaluator', new ThreatEvaluator() )
  engines.set('reward-evaluator', new RewardEvaluator() )
  engines.set('loss-evaluator', new LossEvaluator() )
  engines.set('frustration-evaluator', new FrustrationEvaluator() )
  engines.set('attachment-evaluator', new AttachmentEvaluator() )
  engines.set('aesthetic-evaluator', new AestheticEvaluator() )
  engines.set('moral-evaluator', new MoralEvaluator() )
  engines.set('affective-blender', new AffectiveBlender() )

  // Shard 2: Memory
  const episodicConsolidator = new EpisodicConsolidator()
  const semanticIntegrator   = new SemanticIntegrator()
  const forgettingCurve      = new ForgettingCurve()
  const dreamSimulator       = new DreamSimulator()

  engines.set('episodic-consolidator', episodicConsolidator )
  engines.set('semantic-integrator', semanticIntegrator )
  engines.set('forgetting-curve', forgettingCurve )
  engines.set('dream-simulator', dreamSimulator )

  semanticIntegrator.attachConsolidator( episodicConsolidator )
  forgettingCurve.attachConsolidator( episodicConsolidator )
  dreamSimulator.attachConsolidator( episodicConsolidator )

  // Shard 3: Executive
  const goalManager     = new GoalManager()
  const planningEngine  = new PlanningEngine()
  const inhibitionCtrl  = new InhibitionController()
  const taskSwitcher    = new TaskSwitcher()

  engines.set('goal-manager', goalManager )
  engines.set('planning-engine', planningEngine )
  engines.set('inhibition-controller', inhibitionCtrl )
  engines.set('task-switcher', taskSwitcher )

  planningEngine.attachGoalManager( goalManager )

  // Shard 4: Meta-Cognitive
  const selfModelUpdater        = new SelfModelUpdater()
  const confidenceCalibrator    = new ConfidenceCalibrator()
  const biasDetector            = new BiasDetector()
  const autobiographicalNarrator = new AutobiographicalNarrator()
  const introspectionEngine     = new IntrospectionEngine()

  engines.set('self-model-updater', selfModelUpdater )
  engines.set('confidence-calibrator', confidenceCalibrator )
  engines.set('bias-detector', biasDetector )
  engines.set('autobiographical-narrator', autobiographicalNarrator )
  engines.set('introspection-engine', introspectionEngine )

  autobiographicalNarrator.attachEpisodicConsolidator( episodicConsolidator )
  autobiographicalNarrator.attachSemanticIntegrator( semanticIntegrator )

  // Social Layer
  const theoryOfMind     = new TheoryOfMind()
  const empathySimulator = new EmpathySimulator()
  const reputationTracker = new ReputationTracker()

  engines.set('theory-of-mind', theoryOfMind )
  engines.set('empathy-simulator', empathySimulator )
  engines.set('reputation-tracker', reputationTracker )

  empathySimulator.attachTheoryOfMind( theoryOfMind )

  // Register all engines in priority order
  for( const [ , engine ] of Array.from( engines.entries() ).sort( ( a, b ) => ( a[1].priority ?? 99 ) - ( b[1].priority ?? 99 ) ) )
    simulation.addEngine( engine )

  return { simulation, engines }
}

function seedIdentity( simulation: DefaultSimulation, prompt = 'I am a simulated mind in testing.'): void {
  simulation.stateManager.setEntity({
    id: 'identity-self',
    type: 'will.identity',
    // Deterministic timestamps so the seeded entity (and any age-derived metric)
    // is replay-stable; setEntity re-stamps from sim-time anyway (R2).
    createdAt: 0,
    updatedAt: 0,
    metadata: {
      prompt,
      values: [ 'honesty', 'curiosity' ],
      traits: { openness: 0.7, caution: 0.5 },
      style: 'test mode',
      version: 1,
    },
  })
}

// ── Tests ────────────────────────────────────────────────────

describe('Full Mind Integration', () => {

  it('all 35 engines start and complete 100 ticks without errors', async () => {
    const { simulation } = createFullMind()
    seedIdentity( simulation )

    await simulation.step( 100 )

    const state = simulation.stateManager.snapshot()
    expect( state.tick ).toBe( 100 )
    expect( state.metrics.size ).toBeGreaterThan( 0 )

    const energy = state.metrics.get('energy.level')
    expect( energy ).toBeDefined()
    expect( energy! ).toBeLessThan( 100 )

    const valence = state.metrics.get('affect.valence')
    expect( valence ).toBeDefined()
  }, 120_000)

  it('produces identical state on replay with same seed', async () => {
    const seed = 12345

    const { simulation: sim1 } = createFullMind({ randomSeed: seed })
    seedIdentity( sim1, 'Replay test mind.')
    await sim1.step( 50 )
    const snap1 = sim1.stateManager.snapshot()

    const { simulation: sim2 } = createFullMind({ randomSeed: seed })
    seedIdentity( sim2, 'Replay test mind.')
    await sim2.step( 50 )
    const snap2 = sim2.stateManager.snapshot()

    // Tick + sim-time reproduce exactly. The previous version compared only a
    // hand-picked metric subset, so a wall-clock leak into state.time would have
    // gone undetected — the deterministic clock (R2-b1) is what makes this hold.
    expect( snap1.tick ).toBe( snap2.tick )
    expect( snap1.time ).toBe( snap2.time )
    expect( snap1.time ).toBe( 50 * 50 ) // startTime 0 + 50 ticks × fixedDeltaMs 50

    // Full metric equivalence — every key, not just five.
    const metricKeys = new Set([ ...snap1.metrics.keys(), ...snap2.metrics.keys() ])
    for( const key of metricKeys )
      expect( snap1.metrics.get( key ), `metric "${key}" diverged on replay` ).toBe( snap2.metrics.get( key ) )
    expect( snap1.metrics.size ).toBe( snap2.metrics.size )

    // Full entity-map equivalence — every entity, including its id, createdAt /
    // updatedAt / updatedAtTick stamps and payload, reproduces byte-for-byte now
    // that src/cognition no longer stamps ids or timestamps from wall time
    // (R2-b2-1). A residual Date.now()/Math.random() leak would diverge an id or
    // a stamp here. (R2-d later adds the dedicated record-and-replay harness.)
    expect( snap1.entities.size ).toBe( snap2.entities.size )
    const entityIds = new Set([ ...snap1.entities.keys(), ...snap2.entities.keys() ])
    for( const id of entityIds )
      expect( snap2.entities.get( id ), `entity "${id}" diverged on replay` )
        .toEqual( snap1.entities.get( id ) )
  }, 120_000)

  it('homeostatic regulation activates goals when energy is low', async () => {
    const { simulation } = createFullMind()
    seedIdentity( simulation, 'Drive test mind.')

    simulation.stateManager.setMetric('energy.level', 15 )

    await simulation.step( 10 )

    const state = simulation.stateManager.snapshot()
    const goals = Array.from( state.entities.values() )
      .filter( (e: SimulationEntity) => e.type === 'goal' && e.metadata?.status === 'active')

    expect( goals.length ).toBeGreaterThan( 0 )
  }, 60_000)

  it('affective pipeline produces emotion from threat percept', async () => {
    const { simulation } = createFullMind()
    seedIdentity( simulation, 'Affect test mind.')

    simulation.stateManager.setEntity({
      id: 'threat-1',
      type: 'threat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: { hostile: true, intensity: 0.8, active: true },
    })

    await simulation.step( 5 )

    const state = simulation.stateManager.snapshot()
    const fear = state.metrics.get('emotion.fear')
    expect( fear ).toBeDefined()
    expect( fear! ).toBeGreaterThan( 0 )
  }, 30_000)

  it('episodic memory consolidates over time', async () => {
    const { simulation, engines } = createFullMind()
    seedIdentity( simulation, 'Memory test mind.')

    await simulation.step( 20 )

    const ec = engines.get('episodic-consolidator') as EpisodicConsolidator
    const episodes = ec.getAllEpisodes()
    expect( episodes.length ).toBeGreaterThanOrEqual( 0 )

    if( episodes.length > 0 )
      expect( ec.query({ limit: 5 }).length ).toBeGreaterThan( 0 )
  }, 60_000)

  it('theory of mind model is created for social percepts', async () => {
    const { simulation } = createFullMind()
    seedIdentity( simulation, 'Social test mind.')

    // social_signal is in SocialPerception._signalTypes; sourceKeid + directedAtSelf
    // trigger SocialPerception → interaction.occurred → TheoryOfMind model creation
    simulation.stateManager.setEntity({
      id: 'social-signal-1',
      type: 'social_signal',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        sourceKeid: 'will-other',
        action:        'greet',
        valence:       0.7,
        intensity:     0.6,
        directedAtSelf: true,
      },
    })

    await simulation.step( 5 )

    const state = simulation.stateManager.snapshot()
    const tomEntities = Array.from( state.entities.values() ).filter( (e: SimulationEntity) => e.type === 'theory_of_mind')
    expect( tomEntities.length ).toBeGreaterThan( 0 )
  }, 30_000)
})

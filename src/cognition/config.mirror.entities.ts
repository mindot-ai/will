//
// These entities make every tunable engine parameter visible to the executive
// reasoning cycle, metacognition engines, and future self-tuning features.
//
// Architecture contract:
//   • Engines currently read their config from constructor parameters (fast path).
//   • These entities are the *readable* mirror of those resolved values.
//   • Future work: engines read from state each tick so a MetacognitionEngine
//     can write updated values and have them take effect without a restart.
//     That read path is already implemented in each engine via _readConfigFromState().
//
// The executive can reference `engine.config` entities in its context prompt to
// reason about its own operational parameters.

import { WillConfig } from '#stem/mind'

export interface EngineConfigEntity {
  id:     string
  engine: string
  params: Record<string, unknown>
}

export function buildEngineConfigEntities( config: WillConfig, executiveInterval: number ): EngineConfigEntity[] {
  const selfBelonging  = parseFloat( process.env.WILL_SELF_BELONGING  ?? '0.35')
  const boredomRate    = parseFloat( process.env.WILL_BOREDOM_RATE    ?? '0.005')
  const curiosityFloor = parseFloat( process.env.WILL_CURIOSITY_FLOOR ?? '0.08')
  const summaryInterval   = parseInt( process.env.WILL_SUMMARY_INTERVAL   ?? '10')
  const summaryBufferSize = parseInt( process.env.WILL_SUMMARY_BUFFER_SIZE ?? '12')

  return [
    // ── System metadata ──────────────────────────────────────────
    {
      id: 'engine-config-system',
      engine: 'system',
      params: {
        anatomy:        config.anatomy ?? 'mind',
        model:          config.llm?.model ?? '',
        tickIntervalMs: config.tickIntervalMs ?? 1000
      }
    },

    // ── Regulatory ───────────────────────────────────────────────
    {
      id: 'engine-config-energy',
      engine: 'energy',
      params: {
        maxEnergy:               100,
        baseDecayRate:           0.02,
        restReplenishRate:       0.15,
        lowEnergyThreshold:      30,
        criticalEnergyThreshold: 10,
        collapseThreshold:       1,
        recoveryThreshold:       15,
      },
    },
    {
      id: 'engine-config-sleep',
      engine: 'sleep',
      params: {
        wakeAccumulationRate: 0.008,
        restDissipationRate:  0.04,
        maxPressure:          100,
        fatigueThreshold:     40,
        exhaustionThreshold:  70,
      },
    },
    {
      id: 'engine-config-circadian',
      engine: 'circadian',
      params: {
        periodHours:      24.2,
        phaseOffsetHours: 0,
        entrainable:      1,   // boolean stored as 1/0 for numeric consistency
      },
    },
    {
      id: 'engine-config-attention',
      engine: 'attention',
      params: {
        maxCapacity: 100,
        costPerFocus: 5,
        maxFoci:      4,
        shiftInertia: 0.7,
      },
    },
    {
      id: 'engine-config-stress',
      engine: 'stress',
      params: {
        baseDecayRate:     1.5,   // overridden in mind.ts from default 0.01
        optimalThreshold:  30,
        distressThreshold: 50,
        overloadThreshold: 75,
        maxLoad:           100,
      },
    },

    // ── Perceptual ───────────────────────────────────────────────
    {
      id: 'engine-config-exteroception',
      engine: 'exteroception',
      params: {
        maxPerceptsPerTick: 50,
        defaultSalience:    0.3,
        emitPerceptEvents:  1,
      },
    },
    {
      id: 'engine-config-interoception',
      engine: 'interoception',
      params: {
        emitDetailEvent: 0,
      },
    },
    {
      id: 'engine-config-social-perception',
      engine: 'social-perception',
      params: {
        maxPerceptsPerTick: 20,
      },
    },
    {
      id: 'engine-config-novelty',
      engine: 'novelty',
      params: {
        learningRate:          0.1,
        windowSize:            10,
        significanceThreshold: 0.4,
      },
    },

    // ── Affective ────────────────────────────────────────────────
    {
      id: 'engine-config-threat',
      engine: 'threat',
      params: {
        hostileWeight:     0.35,
        scarcityWeight:    0.25,
        uncertaintyWeight: 0.20,
        socialWeight:      0.20,
        fearEventThreshold: 0.6,
      },
    },
    {
      id: 'engine-config-reward',
      engine: 'reward',
      params: {
        goalWeight:      0.40,
        socialWeight:    0.25,
        resourceWeight:  0.15,
        discoveryWeight: 0.20,
        socialDecayRate: 0.02,
        socialWarmthBoost: 0.4,
      },
    },
    {
      id: 'engine-config-loss',
      engine: 'loss',
      params: {
        significantLossThreshold: 0.5,
        decayRate:                0.05,
      },
    },
    {
      id: 'engine-config-frustration',
      engine: 'frustration',
      params: {
        stuckThreshold:   5,
        irritabilityRate: 0.02,
        decayRate:        0.08,
        habituationRate:  0.03,
        // How strongly provocation (unfairness + blocked progress) becomes anger.
        // Channel A: the metacog loop develops it DOWN from demonstrated `agreeableness`
        // (yielding in conflict — accommodate rather than retaliate). This is the baseline.
        angerReactivity:  0.7,
      },
    },
    {
      id: 'engine-config-attachment',
      engine: 'attachment',
      params: {
        selfBelonging,
        attachmentGrowthRate:   0.05,
        attachmentDecayRate:    0.002,
        lonelinessThreshold:    0.4,
        minInteractionsForBond: 3,
      },
    },
    {
      id: 'engine-config-aesthetic',
      engine: 'aesthetic',
      params: {
        boredomRate,
        curiosityFloor,
        aweThreshold:      0.8,
        curiosityRangeMin: 0.2,
        curiosityRangeMax: 0.7,
      },
    },
    {
      id: 'engine-config-moral',
      engine: 'moral',
      params: {
        eventThreshold: 0.3,
        decayRate:      0.02,
        // Moral foundations stored flat — keys map 1:1 to the six MFT
        // foundations the engine tracks (care, fairness, loyalty, authority,
        // sanctity, liberty). Values are the constructor's normalized weights
        // (sum 1.0); the engine re-normalizes after applying them.
        foundationCare:      0.25,
        foundationFairness:  0.25,
        foundationLoyalty:   0.15,
        foundationAuthority: 0.10,
        foundationSanctity:  0.10,
        foundationLiberty:   0.15,
      },
    },
    {
      id: 'engine-config-affective-blender',
      engine: 'affective-blender',
      params: {
        inertia:          0.5,
        emitBlendEvents:  0,
      },
    },

    // ── Memory ───────────────────────────────────────────────────
    {
      id: 'engine-config-working-memory',
      engine: 'working-memory',
      params: {
        maxChunks:           7,
        baseDecayRate:       0.08,
        attentionProtection: 0.6,
        retrievalThreshold:  0.05,
      },
    },
    {
      id: 'engine-config-episodic',
      engine: 'episodic',
      params: {
        consolidationThreshold: 0.25,
        emotionBoost:           2.0,
        maxPerTick:             5,
      },
    },
    {
      id: 'engine-config-semantic',
      engine: 'semantic',
      params: {
        minIntervalTicks:         30,
        minNewEpisodes:           10,
        maxBeliefs:               500,
        beliefStalenessThreshold: 300,
        beliefDecayRate:          0.001,
      },
    },
    {
      id: 'engine-config-forgetting',
      engine: 'forgetting',
      params: {
        baseForgettingRate: 0.02,
        emotionProtection:  0.7,
        pruningThreshold:   0.01,
        maxPrunePerTick:    10,
      },
    },
    {
      id: 'engine-config-spaced-repetition',
      engine: 'spaced-repetition',
      params: {
        reviewIntervalTicks:    50,
        maxReviewsPerCycle:     5,
        minConfidenceForReview: 0.15,
        successBoost:           0.05,
        failurePenalty:         0.08,
        baseIntervalTicks:      10,
        maxIntervalTicks:       500,
        executiveReviewEnabled: 0,   // boolean stored as 1/0 for numeric consistency
      },
    },
    {
      id: 'engine-config-dream',
      engine: 'dream',
      params: {
        maxReactivationsPerTick: 5,
        emotionalDampeningRate:  0.05,
        recombinationProbability: 0.1,
      },
    },

    // ── Executive ────────────────────────────────────────────────
    {
      id: 'engine-config-goal-manager',
      engine: 'goal-manager',
      params: {
        maxActiveGoals:           5,
        priorityDecayRate:        0.005,
        deactivationThreshold:    0.1,
        epistemicBeliefThreshold: 8,
        // Personality dispositions (PMA-seedable per Will; developed by metacog via
        // the persona-prior). Grit/persistence + frustration tolerance.
        gritPriority:             0.8,
        gritPatienceScale:        2,
        frustrationTolerance:     0.5,
      },
    },
    {
      id: 'engine-config-executive',
      engine: 'executive',
      params: {
        executiveInterval: executiveInterval,
        cooldownTicks:   5,
        // Dual-process effort gate (Channel A). Effort demand at/above which the master
        // engages System 2 (deliberate propose→evaluate). The metacog loop develops it
        // DOWN from demonstrated `analytical` disposition via the persona-prior mirror,
        // so a more analytical Will deliberates more readily; this is the baseline.
        deliberateThreshold: 0.5,
        // How many focused facets this Will can hold at once before spawning starts
        // evicting (FacetSupervisor). A structural ceiling, not the live budget:
        // attention scales the allowance *within* it each tick, so a tired or loaded
        // mind narrows on its own. The metacog loop develops it via the persona-prior
        // (openness widens, conscientiousness narrows), which is what makes "how many
        // things I can hold at once" a property of this person rather than a constant.
        maxFacets: 10,
      },
    },
    {
      id: 'engine-config-planning',
      engine: 'planning',
      // Trait-driven supervision dispositions (Channel A). The metacog loop
      // (PersonaConsolidator) develops these from demonstrated conscientiousness
      // via the persona-prior mirror; these are the PMA-seeded baselines.
      params: {
        maxStepRetries:         3,
        surpriseOutcomeQuality: 0.25,
        // How hard the plan asserts its frontier in the action competition
        // (planning-as-prior). 1 = neutral; conscientiousness develops it UP so a
        // conscientious Will pushes its plan against competing impulses.
        planBiasGain:           1,
      },
    },
    {
      id: 'engine-config-inhibition',
      engine: 'inhibition',
      params: {
        baseInhibitionStrength: 0.6,
        arousalThreshold:       0.6,
        maxDeferralsPerTick:    3,
      },
    },
    {
      id: 'engine-config-task-switcher',
      engine: 'task-switcher',
      params: {
        baseSwitchCost:  0.3,
        switchThreshold: 0.2,
        minFocusTicks:   3,
      },
    },
    {
      // Agency action-selection apparatus (Channel A). `switchCost` is the selector's
      // preemption hysteresis on the *activation* scale — the second owner of the same
      // "switch resistance" disposition the task-switcher develops in attention space.
      // Conscientiousness raises it (less distractible → sees actions through); the
      // selector modulates it by the shared `task_switch.current_focus_ticks` signal.
      // `riskWeight` / `noveltyWeight` are competition weights the selector reads back
      // (base ⊕ prior): emotional-stability lowers risk (bolder), openness raises novelty
      // (curiosity pulls toward the unpracticed). Mirror DEFAULT_WEIGHTS in scoring.ts.
      id: 'engine-config-action-selector',
      engine: 'action-selector',
      params: {
        switchCost:   0.15,
        riskWeight:   0.20,
        noveltyWeight: 0.10,
        // How hard an act's own live footprint damps doing it again (EXAFFERENCE
        // P5) — how long this mind sits with something it has already said before
        // saying it again. Agreeableness develops it up, demonstrated persistence
        // down, so "gives people room" vs "chases an answer" is a trait rather
        // than a constant.
        repeatDamping: 0.30,
      },
    },

    // ── Meta-cognitive ───────────────────────────────────────────
    {
      id: 'engine-config-self-model',
      engine: 'self-model',
      params: {
        minIntervalTicks:    200,
        minNewExperiences:   20,
      },
    },
    {
      id: 'engine-config-confidence',
      engine: 'confidence',
      params: {
        minSamplesPerDomain: 5,
        calibrationRate:     0.1,
        maxAdjustment:       0.3,
      },
    },
    {
      id: 'engine-config-bias-detector',
      engine: 'bias-detector',
      params: {
        minDecisions:      10,
        scanIntervalTicks: 100,
        emitBiasEvents:    1,
      },
    },
    {
      id: 'engine-config-narrator',
      engine: 'narrator',
      params: {
        minIntervalTicks:   50,
        maxNarrativeLength: 5000,
      },
    },
    {
      id: 'engine-config-introspection',
      engine: 'introspection',
      params: {
        cooldownTicks:         50,
        significanceThreshold: 0.4,
      },
    },

    // ── Social ───────────────────────────────────────────────────
    {
      id: 'engine-config-theory-of-mind',
      engine: 'theory-of-mind',
      params: {
        maxModeledAgents:      10,
        beliefDecayRate:       0.002,
        confidenceThreshold:   0.3,
      },
    },
    {
      id: 'engine-config-empathy',
      engine: 'empathy',
      params: {
        resonanceStrength:   0.6,
        compassionThreshold: 0.3,
      },
    },
    {
      id: 'engine-config-reputation',
      engine: 'reputation',
      params: {
        maxTrackedAgents: 20,
        decayRate:        0.001,
        minInteractions:  3,
        // How much a cooperative interaction raises an agent's cooperativeness (trust step).
        // Channel A: the metacog loop develops it UP from demonstrated `agreeableness`
        // (extends trust / benefit-of-the-doubt more readily). This is the baseline.
        trustGrowthStep:  0.05,
      },
    },

    {
      id: 'engine-config-known-entity',
      engine: 'known-entity-tracker',
      params: {
        // How fast a sense of an entity forms per encounter. Channel A: the metacog loop
        // develops it UP from demonstrated `openness` (an open mind grows familiar faster).
        familiarityGrowthRate: 0.15,
        // Gain on the curiosity-to-resolve pull. Channel A: `openness` UP → feels the
        // pull-to-know the half-known more readily.
        curiosityGain:         1.0,
        // How fast a reliability (track-record) judgment is revised per outcome. Channel A:
        // `analytical` UP → updates its assessment more responsively from evidence.
        reliabilityRate:       0.2,
      },
    },

    // ── LLM / Summarizer (standard + full only) ──────────────────
    {
      id: 'engine-config-summarizer',
      engine: 'summarizer',
      params: {
        summaryInterval,
        summaryBufferSize,
        maxCharsPerEntry: 600,
      },
    },
  ]
}

// ─────────────────────────────────────────────────────────────
// src/cognition/engines/index.ts
// ─────────────────────────────────────────────────────────────

import {
  TokenTracker,
  resolvePricing,
  type TokenTrackerConfig,
  type TokenUsage,
  type TokenLedgerRecord,
  type RecordUsageInput,
} from '#cognition/utilities/token.tracker'

import { EnergyRegulator, type EnergyRegulatorConfig } from '#faculties/energy.regulator'
import { SleepPressureRegulator, type SleepPressureConfig } from '#faculties/sleep.pressure.regulator'
import { AttentionAllocator, type AttentionAllocatorConfig } from '#faculties/attention.allocator'
import { StressRegulator, type StressRegulatorConfig } from '#faculties/stress.regulator'
import { CircadianOscillator, type CircadianConfig } from '#faculties/circadian.oscillator'
import { Exteroception, type ExteroceptionConfig } from '#faculties/exteroception'
import { Interoception, type InteroceptionConfig } from '#faculties/interoception'
import { SocialPerception, type SocialPerceptionConfig } from '#faculties/social.perception'
import { NoveltyDetector, type NoveltyDetectorConfig } from '#faculties/novelty.detector'

import { ThreatEvaluator, type ThreatEvaluatorConfig } from '#faculties/threat.evaluator'
import { RewardEvaluator, type RewardEvaluatorConfig } from '#faculties/reward.evaluator'
import { LossEvaluator, type LossEvaluatorConfig } from '#faculties/loss.evaluator'
import { FrustrationEvaluator, type FrustrationEvaluatorConfig } from '#faculties/frustration.evaluator'
import { AttachmentEvaluator, type AttachmentEvaluatorConfig } from '#faculties/attachment.evaluator'
import { AestheticEvaluator, type AestheticEvaluatorConfig } from '#faculties/aesthetic.evaluator'
import { MoralEvaluator, type MoralEvaluatorConfig } from '#faculties/moral.evaluator'
import { AffectiveBlender, type AffectiveBlenderConfig } from '#faculties/affective.blender'

import { WorkingMemory, type WorkingMemoryConfig } from '#faculties/working.memory'
import { EpisodicConsolidator, type EpisodicConsolidatorConfig } from '#faculties/episodic.consolidator'
import { SemanticIntegrator, type SemanticIntegratorConfig } from '#faculties/semantic.engine'
import { SpacedRepetition, type SpacedRepetitionConfig } from './faculties/spaced.repetition'
import { ForgettingCurve, type ForgettingCurveConfig } from '#faculties/forgetting.curve'
import { DreamSimulator, type DreamSimulatorConfig } from '#faculties/dream.simulator'

import { GoalManager, type GoalManagerConfig } from '#faculties/goal.manager'
import { ExecutiveEngine, type ExecutiveEngineConfig } from '#faculties/executive.engine'
import { PlanningEngine, type PlanningEngineConfig, type ActivityEvent, type ActivityEventHandler } from '#faculties/planning.engine/engine'
import { InhibitionController, type InhibitionControllerConfig } from '#faculties/inhibition.controller'
import { TaskSwitcher, type TaskSwitcherConfig } from '#faculties/task.switcher'

import { SelfModelUpdater, type SelfModelUpdaterConfig } from '#faculties/self.model.updater'
import { ConfidenceCalibrator, type ConfidenceCalibratorConfig } from '#faculties/confidence.calibrator'
import { BiasDetector, type BiasDetectorConfig } from '#faculties/bias.detector'
import { AutobiographicalNarrator, type AutobiographicalNarratorConfig } from '#faculties/autobiographical.narrator'
import { IntrospectionEngine, type IntrospectionEngineConfig } from '#faculties/introspection.engine'
import { PersonaConsolidator, type PersonaConsolidatorConfig } from '#faculties/persona.consolidator'

import { TheoryOfMind, type TheoryOfMindConfig } from '#faculties/theory.of.mind'
import { EmpathySimulator, type EmpathySimulatorConfig } from '#faculties/empathy.simulator'
import { ReputationTracker, type ReputationTrackerConfig } from '#faculties/reputation.tracker'
import { KnownEntityTracker, type KnownEntityTrackerConfig } from '#faculties/known.entity.tracker'

import { AuditionEngine }         from '#senses/audition.engine/engine'
import { VisionEngine }           from '#senses/vision.engine'
import { SomatosensationEngine }  from '#senses/somatosensation.engine'
import { OlfactionEngine }        from '#senses/olfaction.engine'
import { GustationEngine }        from '#senses/gustation.engine'

import { InstructionIntake }      from '#agency/engines/instruction.intake'
import { AffordanceSynthesizer }  from '#agency/engines/affordance.synthesizer'
import { ActionSelector }         from '#agency/engines/action.selector'
import { DeliberationEngine }     from '#agency/engines/deliberation.engine'
import { MotorSchemaExecutor }    from '#agency/engines/motor.schema.executor'
import { ReafferenceEngine }      from '#agency/engines/reafference.engine'

/**
 * Regulatory engines — Shard 0.
 * These run every tick synchronously and produce the homeostatic
 * foundation for all other cognitive layers.
 */


export {
  // ── Generic Engines ───────────────────────────────────────

  TokenTracker,
  resolvePricing,
  type TokenTrackerConfig,
  type TokenUsage,
  type TokenLedgerRecord,
  type RecordUsageInput,

  // ── Regulatory Engines ─────────────────────────────────────

  EnergyRegulator,
  type EnergyRegulatorConfig,

  SleepPressureRegulator,
  type SleepPressureConfig,

  AttentionAllocator,
  type AttentionAllocatorConfig,

  StressRegulator,
  type StressRegulatorConfig,

  CircadianOscillator,
  type CircadianConfig,

  Exteroception,
  type ExteroceptionConfig,

  Interoception,
  type InteroceptionConfig,

  SocialPerception,
  type SocialPerceptionConfig,

  NoveltyDetector,
  type NoveltyDetectorConfig,

  // ── Affective Engines ───────────────────────────────────────
  
  ThreatEvaluator,
  type ThreatEvaluatorConfig,

  RewardEvaluator,
  type RewardEvaluatorConfig,

  LossEvaluator,
  type LossEvaluatorConfig,

  FrustrationEvaluator,
  type FrustrationEvaluatorConfig,

  AttachmentEvaluator,
  type AttachmentEvaluatorConfig,

  AestheticEvaluator,
  type AestheticEvaluatorConfig,

  MoralEvaluator,
  type MoralEvaluatorConfig,

  AffectiveBlender,
  type AffectiveBlenderConfig,

  // ── Memory Engines ──────────────────────────────────────────

  WorkingMemory,
  type WorkingMemoryConfig,

  EpisodicConsolidator,
  type EpisodicConsolidatorConfig,

  SemanticIntegrator,
  type SemanticIntegratorConfig,

  SpacedRepetition,
  type SpacedRepetitionConfig,

  ForgettingCurve,
  type ForgettingCurveConfig,

  DreamSimulator,
  type DreamSimulatorConfig,

  // ── Executive Engines ────────────────────────────────────────

  ExecutiveEngine,
  type ExecutiveEngineConfig,

  GoalManager,
  type GoalManagerConfig,

  PlanningEngine,
  type PlanningEngineConfig,
  type ActivityEvent,
  type ActivityEventHandler,


  InhibitionController,
  type InhibitionControllerConfig,

  TaskSwitcher,
  type TaskSwitcherConfig,

  // ── Meta-Cognitive Engines ───────────────────────────────────

  SelfModelUpdater,
  type SelfModelUpdaterConfig,
  
  ConfidenceCalibrator,
  type ConfidenceCalibratorConfig,
  
  BiasDetector,
  type BiasDetectorConfig,
  
  AutobiographicalNarrator,
  type AutobiographicalNarratorConfig,
  
  IntrospectionEngine,
  type IntrospectionEngineConfig,

  PersonaConsolidator,
  type PersonaConsolidatorConfig,

  // ── Social Engines ───────────────────────────────────────────

  TheoryOfMind,
  type TheoryOfMindConfig,
  
  EmpathySimulator,
  type EmpathySimulatorConfig,
  
  ReputationTracker,
  type ReputationTrackerConfig,

  KnownEntityTracker,
  type KnownEntityTrackerConfig,

  // ── Agency Engines ───────────────────────────────────────────

  AuditionEngine,
  VisionEngine,
  SomatosensationEngine,
  OlfactionEngine,
  GustationEngine,

  // ── Senses Engines ───────────────────────────────────────────

  AffordanceSynthesizer,
  ActionSelector,
  DeliberationEngine,
  MotorSchemaExecutor,
  ReafferenceEngine
}

export type EngineRegistry = {
  instructionIntake: InstructionIntake
  energyRegulator: EnergyRegulator
  sleepPressureRegulator: SleepPressureRegulator
  circadianOscillator: CircadianOscillator
  attentionAllocator: AttentionAllocator
  stressRegulator: StressRegulator
  exteroception: Exteroception
  interoception: Interoception
  socialPerception: SocialPerception
  noveltyDetector: NoveltyDetector
  threatEvaluator: ThreatEvaluator
  rewardEvaluator: RewardEvaluator
  lossEvaluator: LossEvaluator
  frustrationEvaluator: FrustrationEvaluator
  attachmentEvaluator: AttachmentEvaluator
  aestheticEvaluator: AestheticEvaluator
  moralEvaluator: MoralEvaluator
  affectiveBlender: AffectiveBlender
  workingMemory: WorkingMemory
  episodicConsolidator: EpisodicConsolidator
  semanticIntegrator: SemanticIntegrator
  spacedRepetition: SpacedRepetition
  forgettingCurve: ForgettingCurve
  dreamSimulator: DreamSimulator
  executiveEngine: ExecutiveEngine
  goalManager: GoalManager
  planningEngine: PlanningEngine
  inhibitionCtrl: InhibitionController
  taskSwitcher: TaskSwitcher
  selfModelUpdater: SelfModelUpdater
  confidenceCalibrator: ConfidenceCalibrator
  biasDetector: BiasDetector
  autobiographicalNarrator: AutobiographicalNarrator
  introspectionEngine: IntrospectionEngine
  personaConsolidator: PersonaConsolidator
  theoryOfMind: TheoryOfMind
  empathySimulator: EmpathySimulator
  reputationTracker: ReputationTracker
  knownEntityTracker: KnownEntityTracker

  // ── Senses ─────────────────────────────────────────────────
  auditionEngine:         AuditionEngine
  visionEngine:           VisionEngine
  somatosensationEngine:  SomatosensationEngine
  olfactionEngine:        OlfactionEngine
  gustationEngine:        GustationEngine

  // ── Agency pipeline (perception→competition→enaction→learning) ─
  affordanceSynthesizer:  AffordanceSynthesizer
  actionSelector:         ActionSelector
  deliberationEngine:     DeliberationEngine
  motorSchemaExecutor:    MotorSchemaExecutor
  reafferenceEngine:      ReafferenceEngine

  // ── Utility Engines ─────────────────────────────────────────
  tokenTracker: TokenTracker
}
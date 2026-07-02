// ─────────────────────────────────────────────────────────────
// src/index.ts
// ─────────────────────────────────────────────────────────────

import { type ClockConfig, DefaultSimulationClock, type SimulationClock } from '#core/clock'
import type { Coordinates, Duration, SimulationContext, SimulationEntity, SimulationEvent, SimulationEventBase, EventPayload, SimulationState, Tick, Timestamp, MinimalContext, RestoreOptions } from '#core/types'
import { DefaultOrchestrator, type Orchestrator, type OrchestratorConfig, type SimulationEngine, type EngineResult } from '#core/orchestrator'
import { DefaultEventBus, type EventBus, type EventBusConfig, type EventFilter, type EventHandler } from '#core/event.bus'
import { DefaultScenario, type Scenario, type ScenarioConfig, type ScenarioValidationResult } from '#core/scenario'
import { DefaultMetricCollector, type MetricCollector, type MetricPoint } from '#core/metrics'
import { DefaultSimulation, type Simulation, type SimulationConfig } from '#core/simulation'
import { DefaultStateManager, type StateManager } from '#core/state.manager'
import { createContext, createPRNG } from '#core/utils'

// New exports
export {
  DefaultSerializer,
  DeltaEncoder,
  type Serializer,
  type SerializationConfig,
  type SerializationFormat,
  type SerializedState,
  type SerializedEntity,
  type DeltaSnapshot
} from '#core/serialization'

export {
  DefaultPartitionRouter,
  ConsistentHashRouter,
  DistributedStateManager,
  DistributedOrchestrator,
  LocalTransport,
  type DistributedNode,
  type DistributedNodeConfig,
  type ShardConfig,
  type ShardStrategy,
  type PartitionRouter,
  type CrossShardTransport,
  type CrossShardQuery,
  type CrossShardResult,
  type DistributedEvent,
  type DeliveryGuarantee
} from '#core/distributed'

export {
  DefaultReplayRecorder,
  DefaultReplaySession,
  ReplayManager,
  type ReplayRecord,
  type ReplayMetadata,
  type ReplaySession,
  type ReplayRecorder,
  type ReplayConfig,
  type ReplayComparison,
  type ReplayDifference
} from '#core/replay'

export {
  setCompletionRecorder,
  clearCompletionRecorder,
  getCompletionRecorder,
  type LLMCompletionRecord,
  type LLMCompletionSink
} from '#core/completion.recorder'

// Injectable diagnostic logger
export {
  logger,
  setLogger,
  resetLogger,
  getLogger,
  ConsoleLogger,
  SilentLogger,
  type Logger
} from '#core/logger'

// Core exports
export {
  DefaultSimulation,
  type Simulation,
  type SimulationConfig,
}

export {
  DefaultSimulationClock,
  type SimulationClock,
  type ClockConfig
}

export {
  DefaultEventBus,
  type EventBus,
  type EventBusConfig,
  type EventHandler,
  type EventFilter
}

export {
  DefaultStateManager,
  type StateManager
}

export {
  DefaultOrchestrator,
  type Orchestrator,
  type OrchestratorConfig,
  type SimulationEngine,
  type EngineResult,
}

export {
  DefaultScenario,
  type Scenario,
  type ScenarioConfig,
  type ScenarioValidationResult
}

export {
  DefaultMetricCollector,
  type MetricCollector,
  type MetricPoint
}

// Storage abstractions
export {
  BunStorageAdapter,
  type StorageAdapter
} from '#core/abstracts'

// Utility functions
export {
  createContext,
  createPRNG
}

// Types
export type {
  Timestamp,
  Duration,
  Tick,
  Coordinates,
  SimulationContext,
  SimulationEntity,
  SimulationEvent,
  SimulationEventBase,
  EventPayload,
  SimulationState,
  MinimalContext,
  RestoreOptions
}

export {
  AsyncEngine,
} from '#core/async.engine'

export {
  ConflictDetector,
} from '#core/conflict.detector'

// In the types section, add:
export type {
  ReasoningFootprint,
  ConflictReport,
  ConflictResolution,
  ConflictStrategy,
  AsyncEngineConfig,
} from '#core/types'
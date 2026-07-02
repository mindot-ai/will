// ─────────────────────────────────────────────────────────────
// src/stem/distribution.ts
// ─────────────────────────────────────────────────────────────

/**
 * Distributed deployment configuration for the simulated mind.
*
 * Maps all cognitive engines across 5 shards with resource profiles,
 * cross-shard communication budgets, and graceful degradation
 * strategies.
 */

// ── Shard configuration ──────────────────────────────────────

export interface ShardDeployment {
  /** Shard index */
  index: number
  /** Human-readable name */
  name: string
  /** Node profile */
  profile: ShardProfile
  /** Engines assigned to this shard */
  engines: string[]
  /** Cross-shard dependencies */
  dependsOn: number[]
  /** Latency budget in ms for cross-shard communication */
  latencyBudgetMs: number
  /** Graceful degradation behavior */
  degradation: DegradationStrategy
}

export interface ShardProfile {
  /** CPU requirements */
  cpu: 'low' | 'medium' | 'high'
  /** Memory requirements */
  memory: 'low' | 'medium' | 'high'
  /** Storage requirements */
  storage: 'none' | 'sqlite' | 'postgres'
  /** GPU/LLM requirements */
  llm: boolean
  /** Expected tick latency contribution */
  expectedLatencyMs: number
}

export type DegradationStrategy =
  | 'fail-stop'       // Shard failure stops the mind
  | 'degrade-gracefully'  // Shard failure degrades related functions
  | 'best-effort'     // Shard failure is non-critical

// ── Deployment map ───────────────────────────────────────────

export const MIND_SHARD_DEPLOYMENT: ShardDeployment[] = [
  {
    index: 0,
    name: 'Regulatory & Perceptual',
    profile: {
      cpu: 'medium',
      memory: 'medium',
      storage: 'none',
      llm: false,
      expectedLatencyMs: 5,
    },
    engines: [
      'energy-regulator', 'sleep-pressure-regulator', 'circadian-oscillator',
      'attention-allocator', 'stress-regulator',
      'exteroception', 'interoception', 'social-perception', 'novelty-detector',
      'working-memory',
    ],
    dependsOn: [],
    latencyBudgetMs: 2,
    degradation: 'fail-stop',  // Brainstem failure = mind failure
  },
  {
    index: 1,
    name: 'Affective & Social',
    profile: {
      cpu: 'high',
      memory: 'medium',
      storage: 'none',
      llm: false,
      expectedLatencyMs: 10,
    },
    engines: [
      'threat-evaluator', 'reward-evaluator', 'loss-evaluator',
      'frustration-evaluator', 'attachment-evaluator',
      'aesthetic-evaluator', 'moral-evaluator', 'affective-blender',
      'theory-of-mind', 'empathy-simulator', 'reputation-tracker',
    ],
    dependsOn: [ 0 ],  // Depends on Shard 0 for percepts
    latencyBudgetMs: 5,
    degradation: 'degrade-gracefully',  // Flat affect without emotions
  },
  {
    index: 2,
    name: 'Memory Systems',
    profile: {
      cpu: 'medium',
      memory: 'high',
      storage: 'sqlite',
      llm: false,
      expectedLatencyMs: 15,
    },
    engines: [
      'episodic-consolidator', 'semantic-integrator',
      'forgetting-curve', 'dream-simulator',
    ],
    dependsOn: [ 0, 1 ],  // Percepts + emotional tags
    latencyBudgetMs: 10,
    degradation: 'degrade-gracefully',  // No new memories without consolidation
  },
  {
    index: 3,
    name: 'Executive Cognition',
    profile: {
      cpu: 'high',
      memory: 'high',
      storage: 'none',
      llm: true,  // GPU required for local LLM inference
      expectedLatencyMs: 500,  // LLM calls are slow
    },
    engines: [
      'goal-manager', 'planning-engine', 'decision-engine',
      'inhibition-controller', 'task-switcher',
    ],
    dependsOn: [ 0, 1, 2 ],  // Needs percepts, affect, memories
    latencyBudgetMs: 200,
    degradation: 'degrade-gracefully',  // Reflexive behavior without deliberation
  },
  {
    index: 4,
    name: 'Meta-Cognition',
    profile: {
      cpu: 'medium',
      memory: 'medium',
      storage: 'none',
      llm: true,
      expectedLatencyMs: 300,
    },
    engines: [
      'self-model-updater', 'confidence-calibrator', 'bias-detector',
      'autobiographical-narrator', 'introspection-engine',
    ],
    dependsOn: [ 2, 3 ],  // Memories + decisions
    latencyBudgetMs: 150,
    degradation: 'best-effort',  // Self-awareness is non-critical for operation
  },
]

// ── Cross-shard event types ──────────────────────────────────

export interface CrossShardMindEvent {
  sourceShard: number
  targetShard: number
  engineName: string
  eventType: string
  payload: unknown
  timestamp: number
}

// ── Shard health monitoring ──────────────────────────────────

export interface ShardHealth {
  shardIndex: number
  status: 'healthy' | 'degraded' | 'failed'
  lastHeartbeat: number
  averageLatencyMs: number
  pendingEvents: number
  circuitBreakerOpen: boolean
}

// ── Deployment helpers ───────────────────────────────────────

/**
 * Get engines for a specific shard.
 */
export function getEnginesForShard( shardIndex: number ): string[] {
  const deployment = MIND_SHARD_DEPLOYMENT.find( d => d.index === shardIndex )
  return deployment?.engines ?? []
}

/**
 * Get the shard for a specific engine.
 */
export function getShardForEngine( engineName: string ): number {
  for( const deployment of MIND_SHARD_DEPLOYMENT ){
    if( deployment.engines.includes( engineName ) )
      return deployment.index
  }

  throw new Error(`Engine not found in deployment map: ${engineName}`)
}

/**
 * Get all cross-shard dependencies as a directed graph.
 */
export function getDependencyGraph(): Map<number, number[]> {
  const graph = new Map<number, number[]>()

  for( const deployment of MIND_SHARD_DEPLOYMENT )
    graph.set( deployment.index, deployment.dependsOn )

  return graph
}
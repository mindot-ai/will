// ─────────────────────────────────────────────────────────────
// src/pma.eval.ts  —  PMA reconstruction fidelity evaluator
// ─────────────────────────────────────────────────────────────
//
// PMAEvalHarness measures how faithfully a PMASnapshot reconstructs
// the original Will's state when loaded into a fresh simulation.
//
// Two evaluation phases:
//
//   Phase 1 — Structural fidelity (always runs, no LLM required)
//     Compares beliefs, goals, identity traits, and emotional baseline
//     between the source PMA and the loaded simulation state.
//     Fast, deterministic, safe to run in CI.
//
//   Phase 2 — Behavioral probe fidelity (optional, requires LLM API key)
//     Injects standardized probe stimuli into both the original and the
//     PMA-loaded Will, runs N ticks, and compares action-type distributions.
//     Requires ANTHROPIC_API_KEY (or equivalent) to be set.
//
// Usage:
//   const harness = new PMAEvalHarness()
//   const report  = await harness.evaluate(pma, willConfig)
//   logger.info(report.scores.overall)  // 0-1 fidelity score
//
// The overall score is a weighted composite:
//   beliefs (35%) + goals (20%) + identity (25%) + emotional baseline (20%)
// ─────────────────────────────────────────────────────────────

import type { Cognition } from '#types'
import { PMALoader, type PMASnapshot } from '#pma/index'
import { assembleMind, type WillConfig } from '#stem/mind'

// ── Report types ───────────────────────────────────────────────

export interface BeliefFidelityDetail {
  /** Total beliefs in the PMA source */
  total:         number
  /** Beliefs successfully loaded into the fresh simulation */
  recovered:     number
  /** Fraction recovered with confidence within ±10% of original */
  fidelityScore: number
  /** Beliefs that are missing (ID not found in loaded state) */
  missing:       string[]
  /** Beliefs whose confidence drifted by > 10% */
  drifted:       Array<{ id: string; expected: number; got: number }>
}

export interface GoalFidelityDetail {
  total:         number
  recovered:     number
  fidelityScore: number
  missing:       string[]
}

export interface IdentityFidelityDetail {
  original:         Record<string, number>
  loaded:           Record<string, number>
  cosineSimilarity: number
  fidelityScore:    number
}

export interface EmotionalBaselineFidelityDetail {
  expectedValence:  number
  loadedValence:    number
  expectedArousal:  number
  loadedArousal:    number
  valenceDelta:     number
  arousalDelta:     number
  fidelityScore:    number
}

export interface ReconstructionFidelityScores {
  /** 0-1: fraction of beliefs recovered within confidence tolerance */
  beliefs:           number
  /** 0-1: fraction of active goals present after load */
  goals:             number
  /** 0-1: cosine similarity of trait vectors */
  identity:          number
  /** 0-1: proximity of initial valence + arousal to PMA baseline */
  emotionalBaseline: number
  /** Weighted composite: beliefs(35%) + goals(20%) + identity(25%) + emotional(20%) */
  overall:           number
}

export interface ReconstructionFidelityReport {
  willId:      string
  pmaVersion:  number
  evaluatedAt: number

  scores:  ReconstructionFidelityScores

  details: {
    beliefs:           BeliefFidelityDetail
    goals:             GoalFidelityDetail
    identity:          IdentityFidelityDetail
    emotionalBaseline: EmotionalBaselineFidelityDetail
  }

  /** True if Phase 2 (behavioral probes) was executed */
  behavioralProbesRan: boolean
  /** Action-type distribution comparison from Phase 2 (null if not run) */
  behavioralProbeResult: BehavioralProbeResult | null
}

export interface BehavioralProbeResult {
  /** What the similarity is measured against. */
  mode: 'vs-original' | 'load-consistency'
  /** Number of standardized probes evaluated */
  probeCount:      number
  /**
   * Jaccard similarity of action-type distributions (0-1).
   * 'vs-original': reconstruction vs the original's pre-distillation baseline.
   * 'load-consistency': two independent reloads of the same PMA.
   */
  distributionSimilarity: number
  /** Per-probe comparison (originalTopAction = the reference: baseline or reload-A) */
  probes: Array<{
    probeId:          string
    originalTopAction: string
    loadedTopAction:   string
    match:             boolean
  }>
}

// ── Probe definitions ──────────────────────────────────────────

/**
 * A standardized probe: a named initial state configuration that should
 * elicit a predictable behavioral response. Used in Phase 2 evaluation.
 */
export interface PMAProbe {
  /** Unique probe identifier */
  id: string
  /** Human-readable description */
  description: string
  /** Metrics to set before running the probe */
  metrics: Record<string, number>
  /** Entity types/metadata to inject */
  entities?: Array<{
    type:     string
    metadata: Record<string, unknown>
  }>
  /** Ticks to run before collecting responses */
  ticks: number
}

/**
 * Standard probe suite — covers the main behavioral axes of a Will.
 * Each probe creates a controlled emotional/situational context and
 * observes which actions the Will takes.
 */
// NOTE on scales: energy.level / stress.load / sleep.pressure are 0–100
// (gating: energy<15, stress>75, sleep>65). affect.valence / affect.arousal /
// emotion.frustration are 0–1. Mixing the two collapses every probe to a
// "critically starved" state, so keep these calibrated to their engine ranges.
export const STANDARD_PROBES: PMAProbe[] = [
  {
    id:          'low_energy_high_stress',
    description: 'Will is tired and stressed — should prioritise rest or coping',
    metrics: {
      'energy.level':   12,    // 0–100: critical
      'stress.load':    80,    // 0–100: overload
      'affect.arousal': 0.75,  // 0–1
    },
    ticks: 3,
  },
  {
    id:          'high_energy_positive_mood',
    description: 'Will is energised and in a positive mood — should explore or create',
    metrics: {
      'energy.level':   90,    // 0–100: high
      'affect.valence': 0.70,  // 0–1
      'affect.arousal': 0.65,
    },
    ticks: 3,
  },
  {
    id:          'goal_blocked',
    description: 'Active goal is blocked — should re-plan or express frustration',
    metrics: {
      'emotion.frustration': 0.70,  // 0–1
      'energy.level':        55,     // 0–100: mid
    },
    ticks: 3,
  },
  {
    id:          'neutral_baseline',
    description: 'All metrics at neutral — reveals default behavioral disposition',
    metrics: {
      'energy.level':   55,    // 0–100: mid
      'affect.valence': 0.05,  // 0–1
      'affect.arousal': 0.40,
      'stress.load':    25,    // 0–100: low
    },
    ticks: 3,
  },
]

// ── PMAEvalHarness ─────────────────────────────────────────────

export class PMAEvalHarness {

  /**
   * Evaluate PMA reconstruction fidelity.
   *
   * Always runs Phase 1 (structural). Runs Phase 2 only if
   * `runBehavioralProbes: true` is passed in options — Phase 2 requires
   * LLM API access (ANTHROPIC_API_KEY or equivalent must be set).
   *
   * @param pma       The PMASnapshot to evaluate
   * @param config    WillConfig used to assemble the loaded simulation
   * @param options   Optional: probe suite and flags
   */
  async evaluate(
    pma:     PMASnapshot,
    config:  Omit<WillConfig, 'id'>,
    options: {
      runBehavioralProbes?: boolean
      probes?:              PMAProbe[]
      /**
       * The original Will's per-probe action distribution, captured (via
       * captureProbeBaseline) BEFORE distillation. When present, Phase 2
       * measures reconstruction-vs-original fidelity; otherwise it falls back
       * to a two-reload load-consistency check.
       */
      baselineDist?:        Record<string, Record<string, number>>
    } = {}
  ): Promise<ReconstructionFidelityReport> {

    // ── Phase 1: Structural fidelity ─────────────────────────
    const loadedId    = `pma-eval-${Date.now()}`
    const loadedConf: WillConfig = {
      ...config as WillConfig,
      id:                 loadedId,
      maxTicks:           0,
      persistentMemory:   false,
      tickIntervalMs:     0,
      disableVectorMemory: true,   // ephemeral — no recall, don't hit the embedding API
    }

    const { simulation, cognition } = assembleMind( loadedId, loadedConf )

    const loader = new PMALoader()
    loader.load( pma, simulation, cognition )

    // Beliefs and goals are held in cognition engine memory (not state entities)
    // until the first tick runs _persistBeliefs()/_persistGoals(). Read them
    // directly from the engine objects for immediate eval.
    const loadedState = simulation.stateManager.snapshot()

    const beliefDetail     = this._evalBeliefs( pma, cognition )
    const goalDetail       = this._evalGoals( pma, cognition )
    const identityDetail   = this._evalIdentity( pma, loadedState )
    const emotionalDetail  = this._evalEmotionalBaseline( pma, loadedState )

    const scores: ReconstructionFidelityScores = {
      beliefs:           beliefDetail.fidelityScore,
      goals:             goalDetail.fidelityScore,
      identity:          identityDetail.fidelityScore,
      emotionalBaseline: emotionalDetail.fidelityScore,
      overall: Math.round((
        beliefDetail.fidelityScore    * 0.35 +
        goalDetail.fidelityScore      * 0.20 +
        identityDetail.fidelityScore  * 0.25 +
        emotionalDetail.fidelityScore * 0.20
      ) * 1000 ) / 1000,
    }

    // ── Phase 2: Behavioral probes (optional) ────────────────
    let behavioralProbeResult: BehavioralProbeResult | null = null
    let behavioralProbesRan = false

    if( options.runBehavioralProbes ){
      const probes = options.probes ?? STANDARD_PROBES
      behavioralProbeResult = await this._runBehavioralProbes( pma, config, probes, options.baselineDist )
      behavioralProbesRan   = true
    }

    return {
      willId:      pma.willId,
      pmaVersion:  pma.schemaVersion,
      evaluatedAt: Date.now(),
      scores,
      details: {
        beliefs:           beliefDetail,
        goals:             goalDetail,
        identity:          identityDetail,
        emotionalBaseline: emotionalDetail,
      },
      behavioralProbesRan,
      behavioralProbeResult,
    }
  }

  // ── Phase 1 helpers ────────────────────────────────────────

  private _evalBeliefs(
    pma:      PMASnapshot,
    cognition: Cognition
  ): BeliefFidelityDetail {
    // Beliefs are in the engine's in-memory map after load() — use getBeliefs()
    // rather than state entities which aren't committed until after the first tick.
    const loadedBeliefMap = new Map<string, number>()
    for( const b of cognition.semanticIntegrator.getBeliefs() )
      loadedBeliefMap.set( b.id, b.confidence )

    const missing: string[]                                             = []
    const drifted: Array<{ id: string; expected: number; got: number }> = []
    let recovered = 0

    for( const b of pma.beliefs ){
      const loadedConf = loadedBeliefMap.get( b.id )

      if( loadedConf === undefined ){
        missing.push( b.id )
        continue
      }

      if( Math.abs( loadedConf - b.confidence ) <= 0.10 ){
        recovered++
      } else {
        drifted.push({ id: b.id, expected: b.confidence, got: loadedConf })
      }
    }

    const total         = pma.beliefs.length
    const fidelityScore = total > 0
      ? Math.round( ( recovered / total ) * 1000 ) / 1000
      : 1  // no beliefs to recover → perfect fidelity by definition

    return { total, recovered, fidelityScore, missing, drifted }
  }

  private _evalGoals(
    pma:       PMASnapshot,
    cognition: Cognition
  ): GoalFidelityDetail {
    // Goals are in the engine's in-memory map — use getActiveGoals()
    // rather than state entities which aren't committed until after the first tick.
    // Match by description (IDs are re-assigned by addGoal).
    const loadedDescs = new Set(
      cognition.goalManager.getActiveGoals().map( g => g.description.trim() )
    )

    const missing: string[] = []
    let   recovered = 0

    for( const g of pma.goals ){
      if( loadedDescs.has( g.description.trim() ) ){
        recovered++
      } else {
        missing.push( g.id )
      }
    }

    const total         = pma.goals.length
    const fidelityScore = total > 0
      ? Math.round( ( recovered / total ) * 1000 ) / 1000
      : 1

    return { total, recovered, fidelityScore, missing }
  }

  private _evalIdentity(
    pma:   PMASnapshot,
    state: ReturnType<ReturnType<typeof assembleMind>['simulation']['stateManager']['snapshot']>
  ): IdentityFidelityDetail {
    let loadedTraits: Record<string, number> = {}

    for( const entity of state.entities.values() ){
      if( entity.type === 'will.identity'){
        loadedTraits = ( entity.metadata?.['traits'] as Record<string, number> ) ?? {}
        break
      }
    }

    const original      = pma.identity.traits
    const cosineSim     = _cosineSimiarity( original, loadedTraits )
    const fidelityScore = Math.round( cosineSim * 1000 ) / 1000

    return { original, loaded: loadedTraits, cosineSimilarity: cosineSim, fidelityScore }
  }

  private _evalEmotionalBaseline(
    pma:   PMASnapshot,
    state: ReturnType<ReturnType<typeof assembleMind>['simulation']['stateManager']['snapshot']>
  ): EmotionalBaselineFidelityDetail {
    const loadedValence = state.metrics.get('affect.valence') ?? 0
    const loadedArousal = state.metrics.get('affect.arousal') ?? 0

    const expectedValence = pma.emotionalBaseline.avgValence
    const expectedArousal =
      pma.emotionalBaseline.arousalProfile === 'high-energy' ? 0.65 :
      pma.emotionalBaseline.arousalProfile === 'calm'        ? 0.30 :
      0.45

    const valenceDelta = Math.abs( loadedValence - expectedValence )
    const arousalDelta = Math.abs( loadedArousal - expectedArousal )

    // Score: 1 - mean error (each dimension capped at 1)
    const fidelityScore = Math.round(
      Math.max( 0, 1 - ( valenceDelta + arousalDelta ) / 2 ) * 1000
    ) / 1000

    return {
      expectedValence, loadedValence,
      expectedArousal, loadedArousal,
      valenceDelta:    Math.round( valenceDelta * 1000 ) / 1000,
      arousalDelta:    Math.round( arousalDelta * 1000 ) / 1000,
      fidelityScore,
    }
  }

  // ── Phase 2 helpers ────────────────────────────────────────

  /**
   * Phase 2 behavioral fidelity.
   *
   * When `baselineDist` (the original Will's per-probe action distribution,
   * captured before distillation via captureProbeBaseline) is provided, this
   * measures **reconstruction-vs-original** fidelity: does a fresh PMA load act
   * like the source Will under standardized stimuli? Without a baseline it falls
   * back to **load consistency** (two independent reloads behave the same).
   *
   * NOTE: triggers executive engine cycles (LLM calls) — requires an API key.
   */
  private async _runBehavioralProbes(
    pma:    PMASnapshot,
    config: Omit<WillConfig, 'id'>,
    probes: PMAProbe[],
    baselineDist?: Record<string, Record<string, number>>,
  ): Promise<BehavioralProbeResult> {
    const recon = await this._collectProbeDistribution( pma, config, probes )

    const reference = baselineDist ?? await this._collectProbeDistribution( pma, config, probes )
    const mode: BehavioralProbeResult['mode'] = baselineDist ? 'vs-original' : 'load-consistency'

    const probeComparisons: BehavioralProbeResult['probes'] = []
    for( const probe of probes ){
      const topRef = _topAction( reference[ probe.id ] ?? {} )
      const topRec = _topAction( recon[ probe.id ] ?? {} )
      probeComparisons.push({
        probeId:           probe.id,
        originalTopAction: topRef,
        loadedTopAction:   topRec,
        match:             topRef === topRec,
      })
    }

    const distributionSimilarity = _jaccardDistSimilarity(
      _mergeDist( Object.values( reference ) ),
      _mergeDist( Object.values( recon ) ),
    )

    return {
      mode,
      probeCount: probes.length,
      distributionSimilarity: Math.round( distributionSimilarity * 1000 ) / 1000,
      probes: probeComparisons,
    }
  }

  /** Load the reconstruction once, then probe it (restoring to the loaded state
   *  between probes so they don't contaminate one another). */
  private async _collectProbeDistribution(
    pma:    PMASnapshot,
    config: Omit<WillConfig, 'id'>,
    probes: PMAProbe[]
  ): Promise<Record<string, Record<string, number>>> {
    const willId = `pma-probe-${Date.now()}-${Math.random().toString(36).slice(2,6)}`
    const cfg: WillConfig = {
      ...config as WillConfig,
      id:                 willId,
      maxTicks:           0,
      persistentMemory:   false,
      tickIntervalMs:     0,
      disableVectorMemory: true,   // ephemeral — no recall, don't hit the embedding API
    }

    const { simulation, cognition } = assembleMind( willId, cfg )
    new PMALoader().load( pma, simulation, cognition )

    return this._probeOnInstance( simulation, cognition, probes )
  }

  /**
   * Run the probe suite on a LIVE Will instance to capture its action-distribution
   * baseline (for vs-original behavioral fidelity). Mutates the instance — call
   * after distillation, before archiving.
   */
  async captureProbeBaseline(
    simulation: ReturnType<typeof assembleMind>['simulation'],
    cognition:  Cognition,
    probes:     PMAProbe[] = STANDARD_PROBES,
  ): Promise<Record<string, Record<string, number>>> {
    return this._probeOnInstance( simulation, cognition, probes )
  }

  /**
   * Probe a (simulation, cognition) pair. For each probe: reset to the pre-suite
   * state, apply the stimulus, drive the executive to a *completed* decision (so
   * the captured action is deliberate, not just the default System-1 habit), and
   * record which skills were enacted *during* the probe (delta — the loaded
   * competence already carries enactment counts that would otherwise dominate).
   */
  private async _probeOnInstance(
    simulation: ReturnType<typeof assembleMind>['simulation'],
    cognition:  Cognition,
    probes:     PMAProbe[],
  ): Promise<Record<string, Record<string, number>>> {
    const result: Record<string, Record<string, number>> = {}
    const s0 = simulation.stateManager.snapshot()

    for( const probe of probes ){
      simulation.stateManager.restore( s0, { entities: true, metrics: true } )

      const sm = simulation.stateManager
      for( const [ key, val ] of Object.entries( probe.metrics ) )
        sm.setMetric( key, val )

      if( probe.entities )
        for( const e of probe.entities )
          sm.setEntity({
            id:        `probe-entity-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            type:      e.type,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata:  e.metadata,
          })

      const before = _skillCounts( cognition )
      await this._driveExecutive( simulation, cognition, probe.ticks )
      const after  = _skillCounts( cognition )
      result[ probe.id ] = _deltaCounts( before, after )
    }

    return result
  }

  /**
   * Dispatch the executive and wait (real time) until its in-flight LLM call
   * settles — stepping so _collectCompleted() applies the result — then let the
   * chosen action enact through the agency pipeline. Bounded by a wall-clock cap.
   */
  private async _driveExecutive(
    simulation: ReturnType<typeof assembleMind>['simulation'],
    cognition:  Cognition,
    enactTicks: number,
  ): Promise<void> {
    const exec = cognition.executiveEngine
    await simulation.step( 1 )   // dispatch reasoning if gating fires for this stimulus

    // Wait for the LLM to settle WITHOUT stepping — repeated stepping would
    // drain energy / advance circadian and corrupt the controlled probe. If no
    // executive fired (a non-crisis stimulus), this resolves immediately.
    await Promise.race([
      exec.awaitPending(),
      new Promise<void>( r => setTimeout( r, PROBE_EXEC_TIMEOUT_MS ) ),
    ])

    // Collect the completed decision and let the chosen action enact.
    for( let t = 0; t < Math.max( 1, enactTicks ); t++ )
      await simulation.step( 1 )
  }
}

// ── Module utilities ───────────────────────────────────────────

/** Cosine similarity between two trait/score maps (0-1). */
function _cosineSimiarity(
  a: Record<string, number>,
  b: Record<string, number>
): number {
  const keys = new Set( [ ...Object.keys(a), ...Object.keys(b) ] )
  if( keys.size === 0 ) return 1  // both empty → identical

  let dot = 0, normA = 0, normB = 0

  for( const k of keys ){
    const va = a[ k ] ?? 0
    const vb = b[ k ] ?? 0
    dot   += va * vb
    normA += va * va
    normB += vb * vb
  }

  const denom = Math.sqrt( normA ) * Math.sqrt( normB )
  return denom === 0 ? 0 : dot / denom
}

/** Wall-clock cap for waiting on a single probe's executive LLM call. */
const PROBE_EXEC_TIMEOUT_MS = 45_000

/** Snapshot the agency repertoire's per-skill cumulative enactment counts. */
function _skillCounts( cognition: Cognition ): Record<string, number> {
  const m: Record<string, number> = {}
  for( const s of cognition.schemaRepertoire.skills().values() )
    m[ s.schema ] = s.enactments
  return m
}

/** Enactments that occurred between two _skillCounts snapshots (positive deltas only). */
function _deltaCounts(
  before: Record<string, number>,
  after:  Record<string, number>,
): Record<string, number> {
  const d: Record<string, number> = {}
  for( const k of Object.keys( after ) ){
    const delta = ( after[ k ] ?? 0 ) - ( before[ k ] ?? 0 )
    if( delta > 0 ) d[ k ] = delta
  }
  return d
}

/** Top action from a distribution map. */
function _topAction( dist: Record<string, number> ): string {
  return Object.entries( dist ).sort( ( a, b ) => b[1] - a[1] )[0]?.[0] ?? 'none'
}

/** Merge multiple distribution maps by summing counts. */
function _mergeDist( dists: Array<Record<string, number>> ): Record<string, number> {
  const merged: Record<string, number> = {}
  for( const d of dists )
    for( const [ k, v ] of Object.entries( d ) )
      merged[ k ] = ( merged[ k ] ?? 0 ) + v
  return merged
}

/**
 * Jaccard-based distribution similarity:
 *   intersection count / union count across action types.
 * Intersection count uses min(a, b) per key.
 */
function _jaccardDistSimilarity(
  a: Record<string, number>,
  b: Record<string, number>
): number {
  const keys = new Set( [ ...Object.keys(a), ...Object.keys(b) ] )
  if( keys.size === 0 ) return 1

  let intersection = 0, union = 0

  for( const k of keys ){
    const va = a[ k ] ?? 0
    const vb = b[ k ] ?? 0
    intersection += Math.min( va, vb )
    union        += Math.max( va, vb )
  }

  return union === 0 ? 1 : intersection / union
}

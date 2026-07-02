// ─────────────────────────────────────────────────────────────
// src/pma.ts  —  Personal Mind Model (PMA) layer
// ─────────────────────────────────────────────────────────────
//
// A Persistent Mind Artifact (PMA) is a compressed, portable, versioned JSON 
// artifact that captures a Will's psychological profile and enduring self — beliefs, 
// goals, identity traits, emotional baseline, behavioral fingerprints, and relationship 
// stubs — sufficient to bootstrap a fresh simulation with the same personality 
// and memory trajectory.
//
// PMA = compressed, portable identity artifact that captures a Will's
// accumulated state well enough to bootstrap a new simulation with the
// same beliefs, personality, goals, and emotional baseline.
//
// Two classes:
//   PMADistiller — reads simulation state + JSONL profile logs → PMASnapshot
//   PMALoader    — seeds a fresh simulation from a PMASnapshot
//
// Artifact format: plain JSON, ~10–50 KB depending on belief count.
// schemaVersion is bumped on any breaking change to PMASnapshot.
//
// Typical usage in WillManager:
//   const pma = distiller.distill(willId, willName, state, sessionId)
//   fs.writeFileSync(path, JSON.stringify(pma))
//
//   // — later, new instance —
//   const pma = JSON.parse(fs.readFileSync(path, 'utf8'))
//   loader.load(pma, simulation, cognition)
// ─────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs'
import { join }                     from 'node:path'

import type { SimulationState }    from '#core/types'
import type { DefaultSimulation }  from '#core/simulation'
import type { Cognition }          from '#types'
import type {
  Belief,
  BeliefHistoryEntry,
}  from '#faculties/semantic.engine/integrator'
import { PERSONA_PRIOR_ID, PERSONA_PRIOR_TYPE } from '#cognition/persona.prior'
import type { SchemaRepertoire } from '#agency/schemas/repertoire'
import {
  distillCompetence,
  loadCompetence,
  type CompetenceSnapshot,
} from '#agency/competence.codec'

// ── Schema version ─────────────────────────────────────────────
// Bump this when any field is removed or semantically changed.
// Additive field additions do not require a bump.

export const PMA_SCHEMA_VERSION = 2  // BUMPED due to new fields

// ── PMA types ──────────────────────────────────────────────────

export interface PMAIdentity {
  /** Core identity prompt */
  prompt:  string
  values:  string[]
  traits:  Record<string, number>
  /**
   * Per-trait self-knowledge — personal baseline EMA + recent-shift direction. Persisted
   * so the Will's sense of its OWN norm (graded salience B/C) carries across sessions
   * instead of rebuilding from the population prior on every cold load. Optional: absent
   * in older PMAs (and the self-model rebuilds it either way).
   */
  traitStats?: Record<string, { mean: number; shiftDir: number; shiftTick: number }>
  style:   string
  version: number
  /** Social orientation: 'gregarious', 'ambivert', 'reserved' */
  socialOrientation?: string
  /** Trust propensity (0-1) — how quickly the Will trusts new agents */
  trustPropensity?: number
  /** Memory persistence (0-1) — influences forgetting curve rate */
  memoryPersistence?: number
}

export interface PMABelief {
  id:                 string
  statement:          string
  category:           string
  confidence:         number
  supportingEpisodes: number
  tags:               string[]
  /** Up to 20 history entries — see BeliefHistoryEntry in semantic.integrator.ts */
  history:            BeliefHistoryEntry[]
}

export interface PMAGoal {
  id:                  string
  description:         string
  priority:            number
  progress:            number
  status:              string
  tags:                string[]
  /** 'metric' | 'action' | 'epistemic' — preserved so the restored goal completes via its original mechanism */
  completionType:      'metric' | 'action' | 'epistemic'
  /** Condition expression for 'metric' goals, e.g. "stress.load < 0.3" */
  completionCondition: string | undefined
}

export interface PMAEmotionalBaseline {
  /** Dominant mood label averaged over last sessions: 'positive' | 'neutral' | 'negative' */
  dominantMood:      string
  /** Mean valence across last N sessions (-1 to +1) */
  avgValence:        number
  /** Arousal activation profile: 'high-energy' | 'moderate' | 'calm' */
  arousalProfile:    string
  /** Mean spike events per session */
  avgSpikeFrequency: number
  /** Inherited temperament from identity (0-1, unaffected by recent sessions) */
  temperamentValence: number   // -1 to 1, where 0 = neutral, >0 = optimistic baseline
  /** Emotional reactivity (0-1) — how strongly the Will responds to events */
  reactivity: number
}

export interface PMABehavioral {
  /** Top 3 action effector names by frequency across recent sessions */
  topActions:     string[]
  /** Mean executive.confidence across recent sessions */
  avgConfidence:  number
  /** Goal completion rate — null if no goals observed */
  completionRate: number | null
  /** Risk tolerance inferred from action outcomes (0=cautious, 1=risk-seeking) */
  riskTolerance?: number
  /** Exploration rate (0-1) — how often the Will tries novel actions */
  explorationRate?: number
  /** Impulsivity (0-1) — tendency to act without deliberation */
  impulsivity?: number
}

/**
 * A relationship stub — enough data to re-seed the Will's model of another
 * agent on first session start, preventing a cold-social-reset.
 *
 * Combines `attachment.bond` (emotional closeness) and `reputation` (social trust)
 * into a single record per will. Both can be present, or just one.
 *
 * At load time, `PMALoader` writes these as state entities in the formats that
 * `AttachmentEvaluator._restoreFromState()` and `ReputationTracker._restoreFromState()`
 * already read on the first tick — no new engine APIs required.
 */
export interface PMARelationshipStub {
  /** The other agent's ID */
  keid: string
  /** Optional display name for readability */
  agentName?: string
  /**
   * Compact digest of the last conversation, derived from the most recent
   * consolidated conversation.exchange episode. On load it is re-seeded as a
   * conversation.exchange working-memory item so the Will recalls it through the
   * normal memory pipeline (consolidator → vector → unified recall).
   */
  lastConversationDigest?: string

  // ── Attachment bond ──────────────────────────────────────
  attachment?: {
    attachmentStrength: number
    trustLevel:         number
    positiveRatio:      number
    interactionCount:   number
    sharedExperiences:  number
    dependency:         number
  }

  // ── Reputation ───────────────────────────────────────────
  reputation?: {
    reliability:           number
    cooperativeness:       number
    socialStanding:        number
    trustworthiness:       number
    interactionCount:      number
    positiveInteractions:  number
    negativeInteractions:  number
    confidence:            number
  }

  // ── Mental model (theory of mind) ────────────────────────
  // The crystallised *gist* of how the Will modelled this mind — not the full belief
  // trail (that fades, soul-true). Rides the attachment/reputation-weighted top-N, so a
  // mind only carries across a restart when it also mattered enough to bond/track.
  mentalModel?: {
    modelConfidence:   number
    dominantIntention: string | null
    estimatedEmotion:  string
  }

  // ── Known-entity dossier (the unified node — perceptual + conscious layer) ──
  // The crystallised summary of who/what this is: kind, learned name, how familiar, how
  // it feels, how well-resolved. The senses' encounter trail itself fades; what carries
  // across is the *residue* — that this someone matters and roughly who they are.
  dossier?: {
    kind:                 'sentient' | 'thing'
    name?:                string
    familiarity:          number
    valence:              number
    reliability:          number
    encounterCount:       number
    resolutionConfidence: number
  }
}

/**
 * PMASnapshot — the portable identity artifact.
 *
 * Top-level contract:
 *   - ~10–50 KB for a typical Will (50 beliefs × history)
 *   - Self-contained: can bootstrap a Will with no other files
 *   - Versioned: schemaVersion guards against stale artifacts
 */
export interface PMASnapshot {
  /** Schema version — see PMA_SCHEMA_VERSION */
  schemaVersion:    number
  willId:           string
  willName:         string
  /** Unix ms when this snapshot was produced */
  distilledAt:      number
  /** Session ID that triggered distillation */
  sourceSessionId:  string

  identity:          PMAIdentity
  /** Top 50 beliefs ranked by confidence × log(1 + supportingEpisodes) */
  beliefs:           PMABelief[]
  /** Top 10 active/in_progress goals by priority */
  goals:             PMAGoal[]
  emotionalBaseline: PMAEmotionalBaseline
  behavioral:        PMABehavioral
  /** Top 20 relationship stubs (bonds + reputation) by interaction count */
  relationships:     PMARelationshipStub[]
  /** Total episodic memory count at snapshot time (metadata only — episodes not stored) */
  episodicCount:     number

  /**
   * Learned self-tuning from the metacognition closing cycle — the accommodation
   * the Will has made to itself. `configPriors` are the bounded persona-prior
   * deltas over engine config (engineConfigId → param → delta); `calibrationBias`
   * is the per-domain confidence calibration. Omitted when nothing has been
   * learned yet. Carrying these makes the *accreted* persona portable, not just
   * the seeded identity.
   */
  persona?: {
    configPriors:    Record<string, Record<string, number>>
    calibrationBias: Record<string, number>
  }

  /**
   * The competence layer — the Will's learned skills (habit strength, value,
   * param priors) and the composite schemas it invented. This is what makes a
   * re-embodied Will *act like itself* (its habits, its proceduralized skills),
   * not just believe/feel like itself. Omitted when nothing has been learned.
   * See #agency/pma/competence.codec.
   */
  competence?: CompetenceSnapshot

  meta: {
    beliefCount:         number
    goalCount:           number
    relationshipCount:   number
    /** How many sessions contributed to emotional / behavioral baselines */
    sessionSummaryCount: number
  }
}

// ── PMADistiller ───────────────────────────────────────────────

/**
 * Reads simulation state and JSONL profile logs to
 * produce a PMASnapshot.
 *
 * Profile logs read (last 5 session summaries each):
 *   data/wills/{willId}/profiles/emotional_biography.jsonl
 *   data/wills/{willId}/profiles/behavioral.jsonl
 */
export class PMADistiller {

  /**
   * Produce a PMASnapshot for a Will.
   *
   * @param willId     The Will's ID
   * @param willName   The Will's display name
   * @param state      Current simulation state (from stateManager.snapshot())
   * @param sessionId  Active session ID — recorded as provenance
   * @param dataDir    Root data dir (defaults to WILL_DATA_DIR env or './data')
   * @param repertoire The agency competence layer (in-memory manager). When
   *                   provided, the Will's learned skills + composite schemas are
   *                   distilled into the snapshot. Omit to skip the competence layer.
   */
  distill(
    willId:    string,
    willName:  string,
    state:     SimulationState,
    sessionId: string,
    dataDir:   string = process.env[ 'WILL_DATA_DIR' ] ?? './data',
    repertoire?: SchemaRepertoire,
  ): PMASnapshot {
    const identity      = this._extractIdentity( state )
    const beliefs       = this._extractBeliefs( state )
    const goals         = this._extractGoals( state )
    const relationships = this._extractRelationships( state )
    const episodicCount = state.metrics.get('memory.episodic_total') ?? 0

    const emotionalBio = this._readEmotionalBio( willId, dataDir )
    const behavioral   = this._readBehavioral( willId, dataDir )

    // Enhance identity with inferred social/behavioral parameters
    const enhancedIdentity = this._enhanceIdentity( identity, behavioral )

    const persona = this._extractPersona( state )

    // Competence layer — learned skills + invented composite schemas.
    const competence = repertoire ? distillCompetence( repertoire ) : undefined
    const carryCompetence = competence && ( competence.skills.length > 0 || competence.composites.length > 0 )

    return {
      schemaVersion:   PMA_SCHEMA_VERSION,
      willId,
      willName,
      distilledAt:     Date.now(),
      sourceSessionId: sessionId,
      identity:        enhancedIdentity,
      beliefs,
      goals,
      emotionalBaseline: emotionalBio.baseline,
      behavioral:        behavioral.fingerprint,
      relationships,
      episodicCount,
      ...( persona ? { persona } : {} ),
      ...( carryCompetence ? { competence } : {} ),
      meta: {
        beliefCount:         beliefs.length,
        goalCount:           goals.length,
        relationshipCount:   relationships.length,
        sessionSummaryCount: Math.max( emotionalBio.sessionsRead, behavioral.sessionsRead ),
      },
    }
  }

  // ── Private extraction helpers ────────────────────────────

  /**
   * Extract the learned self-tuning (metacognition closing cycle): the
   * persona-prior config deltas + the confidence-calibration curve. Returns
   * undefined when neither has accreted anything, so the snapshot omits the field.
   */
  private _extractPersona( state: SimulationState ): PMASnapshot['persona'] {
    const priorMeta = state.entities.get( PERSONA_PRIOR_ID )?.metadata as { priors?: Record<string, Record<string, number>> } | undefined
    const calibMeta = state.entities.get( 'calibration-state' )?.metadata as { domainBias?: Record<string, number> } | undefined

    const configPriors    = priorMeta?.priors    ?? {}
    const calibrationBias = calibMeta?.domainBias ?? {}

    if( Object.keys( configPriors ).length === 0 && Object.keys( calibrationBias ).length === 0 )
      return undefined

    return { configPriors, calibrationBias }
  }

  private _extractIdentity( state: SimulationState ): PMAIdentity {
    for( const entity of state.entities.values() ){
      if( entity.type === 'will.identity' ){
        const m = entity.metadata ?? {}
        return {
          prompt:  ( m['prompt']  as string )                     ?? '',
          values:  ( m['values']  as string[] )                   ?? [],
          traits:  ( m['traits']  as Record<string, number> )     ?? {},
          traitStats: ( m['traitStats'] as PMAIdentity['traitStats'] ) ?? undefined,
          style:   ( m['style']   as string )                     ?? '',
          version: ( m['version'] as number )                     ?? 1,
          // These may not exist in older PMAs, but that's fine
          socialOrientation: ( m['socialOrientation'] as string ) ?? undefined,
          trustPropensity:   ( m['trustPropensity']   as number ) ?? undefined,
          memoryPersistence: ( m['memoryPersistence'] as number ) ?? undefined,
        }
      }
    }
    return { prompt: '', values: [], traits: {}, style: '', version: 1 }
  }

  /**
   * Enhance identity with inferred parameters from behavioral data.
   * This bridges the gap between observed behavior and latent personality traits.
   */
  private _enhanceIdentity(
    identity: PMAIdentity,
    behavioral: { fingerprint: PMABehavioral; sessionsRead: number }
  ): PMAIdentity {
    const enhanced = { ...identity }

    // If socialOrientation not explicitly set, infer from top actions
    if( !enhanced.socialOrientation && behavioral.fingerprint.topActions.length > 0 ){
      const topAction = behavioral.fingerprint.topActions[0] ?? ''
      if( topAction.includes( 'social' ) || topAction.includes( 'talk' ) || topAction.includes( 'text' ) ){
        enhanced.socialOrientation = 'gregarious'
      } else if( topAction.includes( 'reflect' ) || topAction.includes( 'meditate' ) ){
        enhanced.socialOrientation = 'reserved'
      } else {
        enhanced.socialOrientation = 'ambivert'
      }
    }

    // If trustPropensity not explicitly set, infer from completion rate
    if( enhanced.trustPropensity === undefined && behavioral.fingerprint.completionRate !== null ){
      // Higher completion rate suggests more optimistic trust in plans
      enhanced.trustPropensity = Math.min( 1, ( behavioral.fingerprint.completionRate * 0.7 ) + 0.3 )
    }

    // If memoryPersistence not explicitly set, infer from confidence patterns
    if( enhanced.memoryPersistence === undefined ){
      // Higher confidence suggests more persistent memory encoding
      enhanced.memoryPersistence = Math.min( 1, ( behavioral.fingerprint.avgConfidence * 0.5 ) + 0.3 )
    }

    return enhanced
  }

  private _extractBeliefs( state: SimulationState ): PMABelief[] {
    const raw: PMABelief[] = []

    for( const entity of state.entities.values() ){
      if( entity.type !== 'belief' ) continue

      const m = entity.metadata ?? {}
      raw.push({
        id:                 entity.id,
        statement:          ( m['statement']          as string )            ?? '',
        category:           ( m['category']           as string )            ?? 'general',
        confidence:         ( m['confidence']         as number )            ?? 0.5,
        supportingEpisodes: ( m['supportingEpisodes'] as number )            ?? 0,
        tags:               ( m['tags']               as string[] )          ?? [],
        history:            ( m['history']            as BeliefHistoryEntry[] ) ?? [],
      })
    }

    // Rank by confidence × log(1 + supportingEpisodes); cap at 50
    raw.sort( ( a, b ) => {
      const sa = a.confidence * Math.log( 1 + a.supportingEpisodes )
      const sb = b.confidence * Math.log( 1 + b.supportingEpisodes )
      return sb - sa
    })

    return raw.slice( 0, 50 )
  }

  private _extractGoals( state: SimulationState ): PMAGoal[] {
    const goals: PMAGoal[] = []

    for( const entity of state.entities.values() ){
      if( entity.type !== 'goal' ) continue

      const m      = entity.metadata ?? {}
      const status = ( m['status'] as string ) ?? 'active'
      if( status !== 'active' && status !== 'in_progress' ) continue

      goals.push({
        id:                  entity.id,
        description:         ( m['description']         as string   ) ?? '',
        priority:            ( m['priority']            as number   ) ?? 0,
        progress:            ( m['progress']            as number   ) ?? 0,
        status,
        tags:                ( m['tags']                as string[] ) ?? [],
        completionType:      ( m['completionType']      as 'metric' | 'action' | 'epistemic' ) ?? 'epistemic',
        completionCondition: ( m['completionCondition'] as string   ) ?? undefined,
      })
    }

    goals.sort( ( a, b ) => b.priority - a.priority )
    return goals.slice( 0, 10 )
  }

  private _extractRelationships( state: SimulationState ): PMARelationshipStub[] {
    const stubs = new Map<string, PMARelationshipStub>()
    // Tracks the tick of the digest currently held per agent, so we keep only
    // the most recent conversation.exchange episode as `lastConversationDigest`.
    const digestTick = new Map<string, number>()

    for( const entity of state.entities.values() ){
      if( entity.type === 'attachment.bond' ){
        const m       = entity.metadata ?? {}
        const keid = m['keid'] as string | undefined
        if( !keid ) continue

        const stub = stubs.get( keid ) ?? { keid }
        stub.attachment = {
          attachmentStrength: ( m['strength']            as number ) ?? 0,
          trustLevel:         ( m['trust']               as number ) ?? 0.5,
          positiveRatio:      ( m['positiveRatio']       as number ) ?? 0.5,
          interactionCount:   ( m['interactionCount']    as number ) ?? 0,
          sharedExperiences:  ( m['sharedExperiences']   as number ) ?? 0,
          dependency:         ( m['dependency']          as number ) ?? 0,
        }
        stubs.set( keid, stub )
      }

      else if( entity.type === 'reputation' ){
        const m       = entity.metadata ?? {}
        const keid = m['keid'] as string | undefined
        if( !keid ) continue

        const stub = stubs.get( keid ) ?? { keid }
        stub.agentName = ( m['name'] as string ) ?? undefined
        stub.reputation = {
          reliability:          ( m['reliability']          as number ) ?? 0.5,
          cooperativeness:      ( m['cooperativeness']      as number ) ?? 0.5,
          socialStanding:       ( m['socialStanding']       as number ) ?? 0.5,
          trustworthiness:      ( m['trustworthiness']      as number ) ?? 0.5,
          interactionCount:     ( m['interactionCount']     as number ) ?? 0,
          positiveInteractions: ( m['positiveInteractions'] as number ) ?? 0,
          negativeInteractions: ( m['negativeInteractions'] as number ) ?? 0,
          confidence:           ( m['confidence']           as number ) ?? 0.5,
        }
        stubs.set( keid, stub )
      }

      else if( entity.type === 'theory_of_mind' ){
        const m       = entity.metadata ?? {}
        const keid = m['keid'] as string | undefined
        if( !keid ) continue

        const stub = stubs.get( keid ) ?? { keid }
        stub.mentalModel = {
          modelConfidence:   ( m['modelConfidence']   as number ) ?? 0.3,
          dominantIntention: ( m['dominantIntention'] as string | null ) ?? null,
          estimatedEmotion:  ( m['estimatedEmotion']  as string ) ?? 'neutral',
        }
        stubs.set( keid, stub )
      }

      else if( entity.type === 'known-entity' ){
        const m    = entity.metadata ?? {}
        const keid = m['keid'] as string | undefined
        if( !keid ) continue

        const stub = stubs.get( keid ) ?? { keid }
        if( !stub.agentName && typeof m['name'] === 'string' ) stub.agentName = m['name'] as string
        stub.dossier = {
          kind:                 ( m['kind']                 as 'sentient' | 'thing' ) ?? 'sentient',
          name:                 ( m['name']                 as string | undefined ),
          familiarity:          ( m['familiarity']          as number ) ?? 0,
          valence:              ( m['valence']              as number ) ?? 0,
          reliability:          ( m['reliability']          as number ) ?? 0.5,
          encounterCount:       ( m['encounterCount']       as number ) ?? 0,
          resolutionConfidence: ( m['resolutionConfidence'] as number ) ?? 0,
        }
        stubs.set( keid, stub )
      }

      // Derive the per-agent conversation digest from consolidated
      // conversation.exchange episodes (the durable record written by the
      // AuditionEngine memory sink + ProactiveCommunicator). The most recent
      // exchange summary wins.
      else if( entity.type === 'episodic_memory'
            && entity.metadata?.['sourceType'] === 'conversation.exchange' ){
        const content = ( entity.metadata['content'] as Record<string, unknown> | undefined ) ?? {}
        const keid = content['entityId'] as string | undefined
        if( !keid ) continue

        const tick = ( content['tick'] as number | undefined )
          ?? ( entity.metadata['tick'] as number | undefined )
          ?? 0
        if( tick < ( digestTick.get( keid ) ?? -Infinity ) ) continue

        const stub = stubs.get( keid ) ?? { keid }
        stub.agentName ??= ( content['entityName'] as string ) ?? undefined
        const digest = content['summary'] as string | undefined
        if( digest ){
          stub.lastConversationDigest = digest
          digestTick.set( keid, tick )
        }
        stubs.set( keid, stub )
      }
    }

    // Soul doctrine: what crystallises across a restart is what *mattered* — attachment is
    // the primary driver, then familiarity + how resolved the referent is, with interaction
    // volume only a faint tiebreaker. The most-attached/most-familiar known entities carry;
    // fleeting acquaintances fade (the forgetting curve, made portable).
    const salienceOf = ( s: PMARelationshipStub ): number =>
      ( s.attachment?.attachmentStrength ?? 0 ) * 2
      + ( s.dossier?.familiarity ?? 0 )
      + ( s.dossier?.resolutionConfidence ?? 0 ) * 0.5
      + Math.min( 1, ( ( s.attachment?.interactionCount ?? 0 ) + ( s.reputation?.interactionCount ?? 0 ) ) * 0.02 )

    return Array.from( stubs.values() )
      .sort( ( a, b ) => salienceOf( b ) - salienceOf( a ) )
      .slice( 0, 20 )
  }

  private _readEmotionalBio(
    willId:  string,
    dataDir: string
  ): { baseline: PMAEmotionalBaseline; sessionsRead: number } {
    const defaultBaseline: PMAEmotionalBaseline = {
      dominantMood:        'neutral',
      avgValence:          0,
      arousalProfile:      'moderate',
      avgSpikeFrequency:   0,
      temperamentValence:  0,
      reactivity:          0.5,
    }

    const filePath = join( dataDir, 'wills', willId, 'profiles', 'emotional_biography.jsonl' )
    if( !existsSync( filePath ) ) return { baseline: defaultBaseline, sessionsRead: 0 }

    const summaries = _readLastNSummaries( filePath, 'session_summary', 5 )
    if( summaries.length === 0 ) return { baseline: defaultBaseline, sessionsRead: 0 }

    const moodCounts: Record<string, number> = {}
    let totalValence      = 0
    let totalSpikes       = 0
    let totalAvgArousal   = 0
    let arousalSamples    = 0
    let totalReactivity   = 0
    let reactivitySamples = 0

    for( const s of summaries ){
      const mood = ( s['dominantMood'] as string ) ?? 'neutral'
      moodCounts[ mood ] = ( moodCounts[ mood ] ?? 0 ) + 1

      totalValence += ( s['avgValence'] as number ) ?? 0
      totalSpikes  += ( s['spikeCount'] as number ) ?? 0

      const arc = s['arousalArc'] as Record<string, number> | undefined
      if( arc?.['min'] !== undefined && arc?.['max'] !== undefined ){
        totalAvgArousal += ( arc['min'] + arc['max'] ) / 2
        arousalSamples++
      }

      // Reactivity inferred from valence range (max - min) within session
      const valenceArc = s['valenceArc'] as Record<string, number> | undefined
      if( valenceArc?.['min'] !== undefined && valenceArc?.['max'] !== undefined ){
        totalReactivity += Math.abs( valenceArc['max'] - valenceArc['min'] )
        reactivitySamples++
      }
    }

    const dominantMood = Object.entries( moodCounts )
      .sort( ( a, b ) => b[1] - a[1] )[ 0 ]?.[0] ?? 'neutral'

    const avgValence        = totalValence / summaries.length
    const avgSpikeFrequency = totalSpikes  / summaries.length
    const avgArousal        = arousalSamples > 0 ? totalAvgArousal / arousalSamples : 0.45
    const arousalProfile    = avgArousal > 0.58 ? 'high-energy' : avgArousal > 0.38 ? 'moderate' : 'calm'
    const reactivity        = reactivitySamples > 0 ? totalReactivity / reactivitySamples : 0.5

    // Temperament valence is the long-term average, not session-specific
    // This could also come from identity traits (e.g., 'optimism' trait)
    const temperamentValence = avgValence

    return {
      baseline: {
        dominantMood,
        avgValence:        Math.round( avgValence        * 1000 ) / 1000,
        arousalProfile,
        avgSpikeFrequency: Math.round( avgSpikeFrequency * 100  ) / 100,
        temperamentValence: Math.round( temperamentValence * 1000 ) / 1000,
        reactivity:        Math.round( reactivity        * 1000 ) / 1000,
      },
      sessionsRead: summaries.length,
    }
  }

  private _readBehavioral(
    willId:  string,
    dataDir: string
  ): { fingerprint: PMABehavioral; sessionsRead: number } {
    const defaultFingerprint: PMABehavioral = {
      topActions:       [],
      avgConfidence:    0.5,
      completionRate:   null,
      riskTolerance:    0.5,
      explorationRate:  0.3,
      impulsivity:      0.3,
    }

    const filePath = join( dataDir, 'wills', willId, 'profiles', 'behavioral.jsonl' )
    if( !existsSync( filePath ) ) return { fingerprint: defaultFingerprint, sessionsRead: 0 }

    const summaries = _readLastNSummaries( filePath, 'session_summary', 5 )
    if( summaries.length === 0 ) return { fingerprint: defaultFingerprint, sessionsRead: 0 }

    const actionTotals: Record<string, number> = {}
    let totalConf      = 0
    let confCount      = 0
    let totalCompleted = 0
    let totalGoals     = 0
    let totalNovelActions = 0
    let totalActions = 0
    let totalImpulsiveActions = 0

    for( const s of summaries ){
      const dist = ( s['actionDist'] as Record<string, number> | undefined ) ?? {}
      for( const [ k, v ] of Object.entries( dist ) ){
        actionTotals[ k ] = ( actionTotals[ k ] ?? 0 ) + v
        totalActions += v
      }

      // Track novel actions (actions not in top 3 from previous sessions)
      const novelCount = s['novelActionCount'] as number | undefined
      if( novelCount !== undefined ){
        totalNovelActions += novelCount
      }

      // Track impulsive actions (actions taken with low confidence or high arousal)
      const impulsiveCount = s['impulsiveActionCount'] as number | undefined
      if( impulsiveCount !== undefined ){
        totalImpulsiveActions += impulsiveCount
      }

      const avgConf = s['avgConfidence'] as number | null | undefined
      if( avgConf !== null && avgConf !== undefined ){
        totalConf += avgConf
        confCount ++
      }

      const gt = s['goalsTotal']     as number | undefined
      const gc = s['goalsCompleted'] as number | undefined
      if( gt !== undefined ) totalGoals     += gt
      if( gc !== undefined ) totalCompleted += gc
    }

    const topActions = Object.entries( actionTotals )
      .sort( ( a, b ) => b[1] - a[1] )
      .slice( 0, 3 )
      .map( ([ k ]) => k )

    const avgConfidence  = confCount > 0 ? totalConf / confCount : 0.5
    const completionRate = totalGoals > 0 ? totalCompleted / totalGoals : null

    // Exploration rate: proportion of actions that were novel
    const explorationRate = totalActions > 0
      ? Math.min( 1, totalNovelActions / ( totalActions * 0.3 ) )  // Normalized: 30% novel = 1.0
      : 0.3

    // Impulsivity: proportion of actions flagged as impulsive
    const impulsivity = totalActions > 0
      ? Math.min( 1, totalImpulsiveActions / ( totalActions * 0.2 ) )  // Normalized: 20% impulsive = 1.0
      : 0.3

    // Risk tolerance: inverse correlation with average confidence (lower confidence = higher risk tolerance)
    // Or could be derived from action types that are inherently risky
    const riskTolerance = 1 - ( avgConfidence * 0.6 )

    return {
      fingerprint: {
        topActions,
        avgConfidence:  Math.round( avgConfidence  * 1000 ) / 1000,
        completionRate: completionRate !== null ? Math.round( completionRate * 1000 ) / 1000 : null,
        riskTolerance:  Math.round( riskTolerance  * 1000 ) / 1000,
        explorationRate: Math.round( explorationRate * 1000 ) / 1000,
        impulsivity:    Math.round( impulsivity    * 1000 ) / 1000,
      },
      sessionsRead: summaries.length,
    }
  }
}

// ── PMALoader ──────────────────────────────────────────────────

/**
 * Seeds a fresh Will simulation from a PMASnapshot.
 *
 * Seeding order matters:
 *   1. Identity → sets 'identity-self' entity so the executive has
 *      character from tick 1.
 *   2. Beliefs → injected via semanticIntegrator.integrateExecutiveBelief()
 *      with cause='pma-load'. Existing beliefs are merged, not duplicated.
 *   3. Goals → re-injected via goalManager.addGoal() for active goals.
 *      Progress is not restored — goals start fresh.
 *   4. Emotional baseline → sets affect.valence + affect.arousal metrics so
 *      the affective system doesn't start from a cold 0/0 state.
 *   5. Temperament → sets identity traits that influence emotional set-point
 *   6. Behavioral parameters → configure executive and memory engines
 *
 * Call AFTER createWill() / assembleMind() but BEFORE the tick loop starts,
 * and only when no prior snapshot was restored (avoids overwriting live state).
 */
export class PMALoader {

  /**
   * Hydrate a simulation from a PMASnapshot.
   *
   * @param pma        The PMASnapshot to load
   * @param simulation The DefaultSimulation to seed into
   * @param cognition  The Will's Cognition registry
   */
  load(
    pma:                 PMASnapshot,
    simulation:          DefaultSimulation,
    cognition:           Cognition,
  ): void {
    const sm = simulation.stateManager

    // ── 1. Identity (with enhanced fields) ────────────────────
    sm.setEntity({
      id:        'identity-self',
      type:      'will.identity',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        prompt:  pma.identity.prompt,
        values:  pma.identity.values,
        traits:  pma.identity.traits,
        traitStats: pma.identity.traitStats,   // restore the Will's own norm (graded salience B/C)
        version: pma.identity.version,
        style:   pma.identity.style,
        socialOrientation: pma.identity.socialOrientation,
        trustPropensity:   pma.identity.trustPropensity,
        memoryPersistence: pma.identity.memoryPersistence,
      },
    })

    // ── 1b. Persona (learned self-tuning from the metacognition cycle) ──
    // Restored as entities — the wired path — so the accreted persona-prior +
    // calibration curve survive into the new session and engines pick them up
    // via readEffectiveParams / the calibrator's first-react rehydration.
    if( pma.persona ){
      if( Object.keys( pma.persona.configPriors ).length > 0 )
        sm.setEntity({
          id:        PERSONA_PRIOR_ID,
          type:      PERSONA_PRIOR_TYPE,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata:  { priors: pma.persona.configPriors, version: 1, updatedAtTick: 0 },
        })
      if( Object.keys( pma.persona.calibrationBias ).length > 0 )
        sm.setEntity({
          id:        'calibration-state',
          type:      'calibration.state',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata:  { domainBias: pma.persona.calibrationBias, updatedAtTick: 0 },
        })
    }

    // ── 1c. Competence (learned skills + invented composite schemas) ──
    // Reloaded into the live repertoire so a re-embodied Will resumes with its
    // habits and skills intact — it acts like itself, not just believes/feels like
    // itself. The ReafferenceEngine mirrors these back into `agency.skill` entities
    // as they are next touched.
    loadCompetence( pma.competence, cognition.schemaRepertoire )

    // ── 2. Beliefs ────────────────────────────────────────────
    // Restore verbatim (preserve id + final confidence). Re-integrating through
    // integrateExecutiveBelief would merge similar stored beliefs into one
    // another (dropping ids) and re-cap confidence by evidence — both corrupt
    // the reconstruction. The live merge/decay dynamics resume once the Will ticks.
    cognition.semanticIntegrator.restoreBeliefs(
      pma.beliefs.map( b => ( {
        id:                 b.id,
        statement:          b.statement,
        category:           b.category as Belief['category'],
        confidence:         b.confidence,
        supportingEpisodes: b.supportingEpisodes,
        lastUpdatedAt:      0,
        tags:               b.tags,
        history:            b.history,
      } ) )
    )

    // ── 3. Goals ──────────────────────────────────────────────
    for( const g of pma.goals ){
      if( g.status !== 'active' && g.status !== 'in_progress' ) continue

      cognition.goalManager.addGoal(
        g.description,
        g.priority,
        g.tags,
        undefined,
        undefined,
        g.completionType,
        g.completionCondition,
        g.id
      )
    }

    // ── 4. Emotional baseline ─────────────────────────────────
    const valence = pma.emotionalBaseline.avgValence

    const arousal =
      pma.emotionalBaseline.arousalProfile === 'high-energy' ? 0.65 :
      pma.emotionalBaseline.arousalProfile === 'calm'        ? 0.30 :
      0.45

    sm.setMetric( 'affect.valence', valence )
    sm.setMetric( 'affect.arousal', arousal )

    // ── 5. Temperament (influences emotional set-point) ───────
    const temperamentValence = pma.emotionalBaseline.temperamentValence
    const reactivity = pma.emotionalBaseline.reactivity

    sm.setEntity({
      id:        'engine-config-affective-blender',
      type:      'engine.config',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        engine: 'affective-blender',
        params: {
          inertia: 1 - reactivity,
          temperamentValence,
        },
      },
    })

    // ── 6. Behavioral parameters ──────────────────────────────
    if( pma.behavioral.riskTolerance !== undefined ||
        pma.behavioral.explorationRate !== undefined ||
        pma.behavioral.impulsivity !== undefined ){

      sm.setEntity({
        id:        'engine-config-executive',
        type:      'engine.config',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          engine: 'executive',
          params: {
            riskTolerance:   pma.behavioral.riskTolerance   ?? 0.5,
            explorationRate: pma.behavioral.explorationRate ?? 0.3,
            impulsivity:     pma.behavioral.impulsivity     ?? 0.3,
          },
        },
      })
    }

    // Configure memory persistence for ForgettingCurve
    if( pma.identity.memoryPersistence !== undefined ){
      sm.setEntity({
        id:        'engine-config-forgetting',
        type:      'engine.config',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          engine: 'forgetting-curve',
          params: {
            baseForgettingRate: 1 - ( pma.identity.memoryPersistence * 0.7 ),
          },
        },
      })
    }

    // ── 7. Relationship stubs ─────────────────────────────────
    const now = Date.now()
    for( const rel of pma.relationships ){
      if( rel.attachment ){
        sm.setEntity({
          id:        `bond-${rel.keid}`,
          type:      'attachment.bond',
          createdAt: now,
          updatedAt: now,
          metadata: {
            keid:             rel.keid,
            strength:            rel.attachment.attachmentStrength,
            trust:               rel.attachment.trustLevel,
            positiveRatio:       rel.attachment.positiveRatio,
            interactionCount:    rel.attachment.interactionCount,
            lastInteractionTick: 0,
            sharedExperiences:   rel.attachment.sharedExperiences,
            dependency:          rel.attachment.dependency,
            tick:                0,
          },
        })
      }

      if( rel.reputation ){
        sm.setEntity({
          id:        `reputation-${rel.keid}`,
          type:      'reputation',
          createdAt: now,
          updatedAt: now,
          metadata: {
            keid:              rel.keid,
            name:                 rel.agentName ?? rel.keid,
            reliability:          rel.reputation.reliability,
            cooperativeness:      rel.reputation.cooperativeness,
            socialStanding:       rel.reputation.socialStanding,
            trustworthiness:      rel.reputation.trustworthiness,
            interactionCount:     rel.reputation.interactionCount,
            positiveInteractions: rel.reputation.positiveInteractions,
            negativeInteractions: rel.reputation.negativeInteractions,
            lastInteractionTick:  0,
            confidence:           rel.reputation.confidence,
          },
        })
      }

      if( rel.mentalModel ){
        // Re-seed the tom-<id> gist in the format TheoryOfMind._restoreFromState() reads,
        // so a re-embodied Will recovers its *sense* of this mind (not the lost detail).
        sm.setEntity({
          id:        `tom-${rel.keid}`,
          type:      'theory_of_mind',
          createdAt: now,
          updatedAt: now,
          metadata: {
            keid:           rel.keid,
            modelConfidence:   rel.mentalModel.modelConfidence,
            dominantIntention: rel.mentalModel.dominantIntention,
            estimatedEmotion:  rel.mentalModel.estimatedEmotion,
            beliefCount:       0,
            intentionCount:    rel.mentalModel.dominantIntention ? 1 : 0,
          },
        })
      }

      if( rel.dossier ){
        // Re-seed the ke-<keid> dossier in the format KnownEntityTracker._restoreFromState()
        // reads, so a re-embodied Will recovers its sense of *who/what* this is — the
        // crystallised residue (kind, name, how familiar, how it feels), not the lost
        // encounter trail. lastSeenTick resets to 0 (a fresh embodiment).
        sm.setEntity({
          id:        `ke-${rel.keid}`,
          type:      'known-entity',
          createdAt: now,
          updatedAt: now,
          metadata: {
            keid:                 rel.keid,
            kind:                 rel.dossier.kind,
            name:                 rel.dossier.name ?? rel.agentName,
            familiarity:          rel.dossier.familiarity,
            valence:              rel.dossier.valence,
            reliability:          rel.dossier.reliability,
            encounterCount:       rel.dossier.encounterCount,
            lastSeenTick:         0,
            resolutionConfidence: rel.dossier.resolutionConfidence,
          },
        })
      }

      // ── 8. Restore conversation context ─────────────────────
      // Re-seed the last conversation as a conversation.exchange working-memory
      // item so it flows through the same pipeline as a live exchange: the
      // EpisodicConsolidator consolidates it into episodic + vector memory, and
      // the executive/facets surface it via unified recall — no cold restart,
      // no dedicated ConversationManager.
      if( rel.lastConversationDigest ){
        sm.setEntity({
          id:        `wm-exchange-restored-${rel.keid}`,
          type:      'working_memory.item',
          createdAt: now,
          updatedAt: now,
          metadata: {
            wmType:        'conversation.exchange',
            activation:    0.7,
            attendedCount: 2,
            tags:          [ 'conversation', 'exchange', 'pma-restored', `entity:${rel.keid}` ],
            summary:       rel.lastConversationDigest,
            entityId:      rel.keid,
            entityName:    rel.agentName ?? rel.keid,
            tick:          0,
          },
        })
      }
    }
  }
}

// ── Module helpers ─────────────────────────────────────────────

/**
 * Read the last N `type: typeName` entries from an NDJSON file.
 * Returns an empty array on any read or parse error.
 */
function _readLastNSummaries(
  filePath: string,
  typeName: string,
  n:        number
): Array<Record<string, unknown>> {
  try {
    return readFileSync( filePath, 'utf8' )
      .split('\n')
      .filter( l => l.trim().length > 0 )
      .map( l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } })
      .filter( ( e ): e is Record<string, unknown> =>
        e !== null && e['type'] === typeName
      )
      .slice( -n )
  } catch {
    return []
  }
}
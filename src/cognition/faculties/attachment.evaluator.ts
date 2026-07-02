// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/attachment.evaluator.ts
// ─────────────────────────────────────────────────────────────

/**
 * AttachmentEvaluator — models relationship bonds with other agents.
 *
 * Evaluates:
 *   - Interaction frequency and recency
 *   - Positive vs. negative interaction ratio
 *   - Dependency (how much the agent relies on this other)
 *   - Trust history (reliability over time)
 *   - Shared experience depth
 *
 * Produces: love, trust, belonging, loneliness
 *
 * Love = strong positive bond with specific other
 * Trust = confidence in another's reliability and benevolence
 * Belonging = sense of connection to a social group
 * Loneliness = absence of meaningful attachment
 *
 * Attachment builds gradually (repeated positive interactions) and
 * decays slowly (bonds persist through absence, but fade over time).
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
} from '#core/types'
import type { CognitiveEngine, SimulationEngine, EngineResult } from '#cognition/types'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

export interface AttachmentEvaluatorConfig {
  /** How quickly attachment builds from positive interactions */
  attachmentGrowthRate?: number
  /** How slowly attachment decays during absence */
  attachmentDecayRate?: number
  /** Threshold for loneliness to become significant */
  lonelinessThreshold?: number
  /** Minimum interactions to consider a bond meaningful */
  minInteractionsForBond?: number
  /**
   * Baseline belonging from self-awareness (0–1).
   * Prevents loneliness from maxing out at boot with no social context.
   * 0.35 ≈ "I know who I am" — connected to self but still meaningfully alone.
   */
  selfBelonging?: number
  bus?: CognitiveBus
}

interface BondModel {
  keid: string
  attachmentStrength: number  // 0-1: overall bond strength
  trustLevel: number          // 0-1: reliability assessment
  positiveRatio: number       // 0-1: proportion of positive interactions
  interactionCount: number
  lastInteractionTick: number
  sharedExperiences: number
  dependency: number           // 0-1: how much agent relies on this other
}

export class AttachmentEvaluator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'attachment-evaluator'
  
  private _growthRate: number
  private _decayRate: number
  private _lonelinessThreshold: number
  private _minInteractionsForBond: number
  private _selfBelonging: number

  // Persistent bond models across ticks
  private _bonds = new Map<string, BondModel>()
  // True after bonds have been rehydrated from snapshot state on first tick
  private _restored = false

  // Inputs from cognitive events
  private _pendingInteractions: Array<{
    keid: string; valence: number; intensity: number
    directedAtSelf: boolean; sharedExperience: boolean
  }> = []
  private _cachedActiveAgents: number = 0
  private _cachedBelonging: number = 0

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: AttachmentEvaluatorConfig = {} ){
    this._bus = config.bus ?? null
    this._growthRate             = config.attachmentGrowthRate  ?? 0.05
    this._decayRate              = config.attachmentDecayRate   ?? 0.002
    this._lonelinessThreshold    = config.lonelinessThreshold   ?? 0.4
    this._minInteractionsForBond = config.minInteractionsForBond ?? 3
    this._selfBelonging          = config.selfBelonging          ?? 0.35
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  /**
   * Attachment strength (0–1) toward a specific agent, or 0 if no bond exists.
   * Read-only accessor used by the AuditionEngine to weight conversational
   * salience by relationship closeness.
   */
  getAttachmentScore( keid: string ): number {
    return this._bonds.get( keid )?.attachmentStrength ?? 0
  }

  // ── Engine interface ─────────────────────────────────────

  subscribes(): string[] {
    return [
      'executive.prediction.formed',
      'interaction.occurred',
      'social.agents.present',
    ]
  }

  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    if( e.type === 'executive.prediction.formed' ){
      const p = e.payload as { predictedDomains: string[]; confidence: number }
      if( p.predictedDomains.includes('social') )
        this._model.setPrecision( 'emotion.love', 1.0 + p.confidence * 0.5 )
    }
    if( e.type === 'interaction.occurred' ){
      const p = e.payload as {
        keid: string; valence: number; intensity: number
        directedAtSelf: boolean; interactionType: string
      }
      this._pendingInteractions.push({
        keid: p.keid,
        valence: p.valence,
        intensity: p.intensity,
        directedAtSelf: p.directedAtSelf,
        sharedExperience: false,
      })
    }
    if( e.type === 'social.agents.present' ){
      const p = e.payload as { activeAgents: number }
      this._cachedActiveAgents = p.activeAgents
    }
  }

  snapshot(): Record<string, unknown> { return {} }

  async react(
    delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    _context: SimulationContext
  ): Promise<EngineResult> {
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { metrics: [] }

    // Channel A (agreeableness → attachment): how fast bonds form is refreshed each tick as
    // base ⊕ persona-prior. An agreeable Will develops a higher growth rate and bonds more
    // readily. (Seed existed but was ignored.)
    this._growthRate = readEffectiveParams( state, 'engine-config-attachment' ).attachmentGrowthRate ?? this._growthRate

    // On the very first tick after construction (including snapshot restores),
    // rehydrate _bonds from attachment.bond entities written by _persistBonds().
    // Without this, a restored Will starts with an empty bond Map and immediately
    // overwrites all saved attachment data with zeros on the first persist cycle.
    if( !this._restored ){
      this._restoreFromState( state )
      this._restored = true
    }

    // 1. Drain buffered interactions and update bond models
    const interactions = this._pendingInteractions.splice( 0 )
    this._processSocialSignals( interactions, tick )

    // 2. Decay bonds for absent agents
    this._decayBonds( delta, tick )

    // 3. Compute attachment emotions from bond models
    const positiveCount = interactions.filter( i => i.valence > 0.3 ).length
    const
    love       = this._computeLove(),
    trust      = this._computeTrust(),
    belonging  = this._computeBelonging( positiveCount ),
    loneliness = this._computeLoneliness( belonging )
    this._cachedBelonging = belonging

    commands.metrics!.push(
      [ 'emotion.love', love ],
      [ 'emotion.trust', trust ],
      [ 'emotion.belonging', belonging ],
      [ 'emotion.loneliness', loneliness ],
      [ 'attachment.bond_count', this._bonds.size ],
      [ 'attachment.strongest_bond', this._strongestBondStrength() ],
    )

    // Persist bond models as entities for other engines to read
    this._persistBonds( commands, tick )

    // Significant bond events
    const strongestBond = this._strongestBond()
    if( strongestBond && strongestBond.attachmentStrength > 0.7 )
      events.push({
        type: 'attachment.strong_bond',
        source: this.name,
        payload: {
          keid: strongestBond.keid,
          strength: strongestBond.attachmentStrength,
          trust: strongestBond.trustLevel,
        },
      })

    if( loneliness > this._lonelinessThreshold )
      events.push({
        type: 'emotion.loneliness.significant',
        source: this.name,
        payload: { loneliness, belonging, bondCount: this._bonds.size },
      })


    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus && love > 0.5 ){
      const predErr = this._model.observe( 'emotion.love', love )
      if( !predErr.gated )
        _bus.publish({ type: 'emotion.love.significant', version: 1, sourceEngine: this.name, salience: Math.min(1, love), payload: { love } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Bond model management ────────────────────────────────

  private _processSocialSignals(
    interactions: Array<{ keid: string; valence: number; intensity: number; directedAtSelf: boolean; sharedExperience: boolean }>,
    tick: Tick
  ): void {
    for( const interaction of interactions ){
      const
      keid        = interaction.keid,
      valence        = interaction.valence,
      directedAtSelf = interaction.directedAtSelf,
      isSharedExp    = interaction.sharedExperience

      if( !keid || keid === 'agent-self') continue

      let bond = this._bonds.get( keid )

      if( !bond ){
        bond = {
          keid,
          attachmentStrength: 0,
          trustLevel: 0.5,  // Neutral starting trust
          positiveRatio: 0.5,
          interactionCount: 0,
          lastInteractionTick: tick,
          sharedExperiences: 0,
          dependency: 0,
        }
        this._bonds.set( keid, bond )
      }

      // Update bond metrics
      bond.interactionCount++
      bond.lastInteractionTick = tick

      // Positive ratio — exponential moving average
      const isPositive = valence > 0
      bond.positiveRatio += this._growthRate * ( ( isPositive ? 1 : 0 ) - bond.positiveRatio )

      // Attachment strength grows with positive interactions
      if( directedAtSelf ){
        const valenceContribution = valence * 0.1
        bond.attachmentStrength = Math.min( 1,
          bond.attachmentStrength + valenceContribution * this._growthRate
        )
      }

      // Trust builds from consistent positive interactions over time
      if( bond.interactionCount >= this._minInteractionsForBond ){
        const reliabilitySignal = isPositive ? 0.1 : -0.15  // Betrayal hurts trust more than reliability builds it
        bond.trustLevel = Math.min( 1, Math.max( 0,
          bond.trustLevel + reliabilitySignal * this._growthRate
        ))
      }

      // Shared experiences deepen bonds
      if( isSharedExp ){
        bond.sharedExperiences++
        bond.attachmentStrength = Math.min( 1,
          bond.attachmentStrength + 0.03 * this._growthRate
        )
      }

      // Dependency increases with interaction frequency
      bond.dependency = Math.min( 1, bond.interactionCount / 100 )
    }
  }

  private _decayBonds( delta: Duration, currentTick: Tick ): void {
    const deltaSeconds = delta / 1000

    for( const [ id, bond ] of this._bonds ){
      const ticksSinceLastInteraction = currentTick - bond.lastInteractionTick

      // Attachment decays slowly during absence
      if( ticksSinceLastInteraction > 10 ){
        const decayFactor = this._decayRate * deltaSeconds * ( ticksSinceLastInteraction / 100 )
        bond.attachmentStrength = Math.max( 0, bond.attachmentStrength - decayFactor )
      }

      // Very old bonds with no interactions can be pruned
      if( ticksSinceLastInteraction > 1000 && bond.attachmentStrength < 0.05 )
        this._bonds.delete( id )
    }
  }

  // ── Emotion computation ──────────────────────────────────

  private _computeLove(): number {
    // Love = strongest attachment bond, thresholded
    const strongest = this._strongestBondStrength()
    return strongest > 0.4 ? strongest : 0
  }

  private _computeTrust(): number {
    // Trust = average trust level across bonds, weighted by attachment
    if( this._bonds.size === 0 ) return 0.5  // Neutral baseline

    let weightedTrust = 0
    let totalWeight = 0

    for( const bond of this._bonds.values() ){
      const weight = bond.attachmentStrength + 0.1
      weightedTrust += bond.trustLevel * weight
      totalWeight += weight
    }

    return totalWeight > 0 ? weightedTrust / totalWeight : 0.5
  }

  private _computeBelonging( positiveSignalCount: number ): number {
    const
    bondCount      = this._bonds.size,
    meanStrength   = bondCount > 0
                       ? Array.from( this._bonds.values() ).reduce( ( s, b ) => s + b.attachmentStrength, 0 ) / bondCount
                       : 0,
    socialPresence = this._cachedActiveAgents,
    positiveSignals = Math.min( 1, positiveSignalCount / 5 )

    const computed = Math.min( 1,
      Math.min( bondCount / 3, 1 ) * 0.4
      + meanStrength * 0.3
      + Math.min( socialPresence / 5, 1 ) * 0.15
      + positiveSignals * 0.15
    )

    // Self-awareness provides a baseline — the Will is never entirely without
    // connection to itself. Social bonds can only add to this floor, not replace it.
    return Math.max( this._selfBelonging, computed )
  }

  private _computeLoneliness( belonging: number ): number {
    // Loneliness spikes when belonging is very low
    return belonging > 0.6 ? 0
         : belonging > 0.3 ? ( 0.6 - belonging ) * 1.5
         : 1 - belonging * 0.5
  }

  // ── Helpers ──────────────────────────────────────────────

  private _strongestBond(): BondModel | null {
    let strongest: BondModel | null = null
    for( const bond of this._bonds.values() ){
      if( !strongest || bond.attachmentStrength > strongest.attachmentStrength )
        strongest = bond
    }
    return strongest
  }

  private _strongestBondStrength(): number {
    return this._strongestBond()?.attachmentStrength ?? 0
  }

  private _restoreFromState( state: ReadonlySimulationState ): void {
    for( const entity of state.entities.values() ){
      if( entity.type !== 'attachment.bond') continue
      const m = entity.metadata
      if( !m?.keid ) continue

      this._bonds.set( m.keid as string, {
        keid:             m.keid             as string,
        attachmentStrength:  m.strength             as number ?? 0,
        trustLevel:          m.trust                as number ?? 0.5,
        positiveRatio:       m.positiveRatio        as number ?? 0.5,
        interactionCount:    m.interactionCount     as number ?? 0,
        lastInteractionTick: m.lastInteractionTick  as number ?? 0,
        sharedExperiences:   m.sharedExperiences    as number ?? 0,
        dependency:          m.dependency           as number ?? 0,
      })
    }
  }

  private _persistBonds( commands: StateCommands, tick: Tick ): void {
    for( const bond of this._bonds.values() ){
      commands.set ??= []
      commands.set.push({
        id: `bond-${bond.keid}`,
        type:     'attachment.bond',
        metadata: {
          keid: bond.keid,
          strength: bond.attachmentStrength,
          trust: bond.trustLevel,
          positiveRatio: bond.positiveRatio,
          interactionCount: bond.interactionCount,
          lastInteractionTick: bond.lastInteractionTick,
          sharedExperiences: bond.sharedExperiences,
          dependency: bond.dependency,
          tick,
        },
      })
    }
  }
}
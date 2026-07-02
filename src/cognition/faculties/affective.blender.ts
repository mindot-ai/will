// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/affective.blender.ts
// ─────────────────────────────────────────────────────────────

/**
 * AffectiveBlender — integrates all discrete emotions into a unified
 * affective state.
 *
 * Reads the output of all other affective evaluators and produces:
 *   - Valence (-1 to +1): overall pleasantness/unpleasantness
 *   - Arousal (0-1): activation/intensity level
 *   - Dominance (0-1): sense of control/agency
 *
 * Handles:
 *   - Emotion blending (bittersweet = joy + sadness coexist)
 *   - Emotional inertia (emotions carry over between ticks)
 *   - Affective amplification (some emotions amplify others)
 *   - Somatic integration (interoceptive signals modulate emotions)
 *
 * This is the final output of the affective layer — the unified
 * "how I feel" that feeds into decision-making and conscious experience.
 *
 * Part of Shard 1 (Affective Layer) — runs every tick, synchronous.
 * Must run LAST among affective engines (priority 17).
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
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import { GenerativeModel } from '#cognition/generative.model'

/**
 * Numeric encoding for dominant emotion metric.
 * Consumers decode using DOMINANT_EMOTION_LABELS[code].
 */
const DOMINANT_EMOTION_CODES: Record<string, number> = {
  'neutral':       0,
  'fear':          1,
  'anxiety':       2,
  'vigilance':     3,
  'joy':           4,
  'satisfaction':  5,
  'excitement':    6,
  'sadness':       7,
  'disappointment': 8,
  'grief':         9,
  'frustration':   10,
  'anger':         11,
  'irritability':  12,
  'love':          13,
  'trust':         14,
  'belonging':     15,
  'loneliness':    16,
  'awe':           17,
  'curiosity':     18,
  'interest':      19,
  'boredom':       20,
  'guilt':         21,
  'shame':         22,
  'pride':         23,
  'indignation':   24,
  'disgust':       25,
}

/**
 * Reverse lookup for debugging/display.
 */
export const DOMINANT_EMOTION_LABELS: Record<number, string> = {}
for( const [ label, code ] of Object.entries( DOMINANT_EMOTION_CODES ) ){
  DOMINANT_EMOTION_LABELS[ code ] = label
}

export interface AffectiveBlenderConfig {
  /** Inertia factor — how much previous affect carries over (0-1) */
  inertia?: number
  /** Whether to emit detailed blend events */
  emitBlendEvents?: boolean
  bus?: CognitiveBus
}

/**
 * PAD state — Pleasure-Arousal-Dominance model.
 * One of the most validated dimensional models of affect.
 */
interface PADState {
  valence: number     // -1 (unpleasant) to +1 (pleasant)
  arousal: number     // 0 (calm) to 1 (excited)
  dominance: number   // 0 (submissive/out of control) to 1 (dominant/in control)
}

/**
 * Mapping from discrete emotions to their PAD coordinates.
 * Based on established affective science (Russell, Mehrabian, Scherer).
 */
const EMOTION_PAD: Record<string, PADState> = {
  // Threat-related
  fear:           { valence: -0.65, arousal: 0.80, dominance: -0.40 },
  anxiety:        { valence: -0.55, arousal: 0.60, dominance: -0.50 },
  vigilance:      { valence:  0.00, arousal: 0.70, dominance:  0.20 },

  // Reward-related
  joy:            { valence:  0.85, arousal: 0.65, dominance:  0.45 },
  satisfaction:   { valence:  0.70, arousal: 0.25, dominance:  0.55 },
  excitement:     { valence:  0.75, arousal: 0.85, dominance:  0.35 },

  // Loss-related
  sadness:        { valence: -0.70, arousal: 0.20, dominance: -0.30 },
  disappointment: { valence: -0.45, arousal: 0.30, dominance: -0.20 },
  grief:          { valence: -0.80, arousal: 0.40, dominance: -0.60 },

  // Frustration-related
  frustration:    { valence: -0.55, arousal: 0.65, dominance: -0.35 },
  anger:          { valence: -0.60, arousal: 0.85, dominance:  0.50 },
  irritability:   { valence: -0.40, arousal: 0.50, dominance: -0.10 },

  // Attachment-related
  love:           { valence:  0.90, arousal: 0.55, dominance:  0.30 },
  trust:          { valence:  0.65, arousal: 0.15, dominance:  0.10 },
  belonging:      { valence:  0.75, arousal: 0.30, dominance:  0.20 },
  loneliness:     { valence: -0.55, arousal: 0.35, dominance: -0.45 },

  // Aesthetic-related
  awe:            { valence:  0.80, arousal: 0.70, dominance: -0.40 },
  curiosity:      { valence:  0.50, arousal: 0.55, dominance:  0.30 },
  interest:       { valence:  0.45, arousal: 0.40, dominance:  0.35 },
  boredom:        { valence: -0.35, arousal: 0.10, dominance: -0.25 },

  // Moral-related
  guilt:          { valence: -0.55, arousal: 0.45, dominance: -0.50 },
  shame:          { valence: -0.65, arousal: 0.55, dominance: -0.65 },
  pride:          { valence:  0.80, arousal: 0.50, dominance:  0.70 },
  indignation:    { valence: -0.50, arousal: 0.75, dominance:  0.55 },
  disgust:        { valence: -0.70, arousal: 0.55, dominance:  0.10 },
}

/**
 * All emotion metric keys the blender integrates.
 */
const EMOTION_KEYS = [
  'emotion.fear',
  'emotion.anxiety',
  'emotion.vigilance',
  'emotion.joy',
  'emotion.satisfaction',
  'emotion.excitement',
  'emotion.sadness',
  'emotion.disappointment',
  'emotion.grief',
  'emotion.frustration',
  'emotion.anger',
  'emotion.irritability',
  'emotion.love',
  'emotion.trust',
  'emotion.belonging',
  'emotion.loneliness',
  'emotion.awe',
  'emotion.curiosity',
  'emotion.interest',
  'emotion.boredom',
  'emotion.guilt',
  'emotion.shame',
  'emotion.pride',
  'emotion.indignation',
  'emotion.disgust',
]

// How strongly empathy's vicarious affect (resonating with others' emotions) bleeds into
// the Will's own blended PAD. Modest — empathy already dampens by resonance × closeness.
const EMPATHY_CONTAGION_WEIGHT = 0.4

export class AffectiveBlender implements SimulationEngine, CognitiveEngine {
  readonly name     = 'affective-blender'

  private _inertia:            number = 0.5
  private _temperamentValence: number = 0
  private _emitBlendEvents:    boolean = false

  private _previousPAD:        PADState = { valence: 0, arousal: 0.3, dominance: 0.5 }

  private _emotionHistory: Map<string, number[]> = new Map()

  private _moodBaseline:       number = 0.5
  private _energyLevel:        number = 100
  private _comfort:            number = 0.5
  private _sleepPressure:      number = 0
  private _stressLoad:         number = 0

  private _socialArousalSurge: number = 0
  private _socialValenceBump:  number = 0

  private _bus: CognitiveBus | null = null

  private readonly _model = new GenerativeModel()

  constructor( config: AffectiveBlenderConfig = {} ){
    this._bus = config.bus ?? null
    this._inertia         = config.inertia         ?? 0.5
    this._emitBlendEvents = config.emitBlendEvents ?? false
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const cfg = state.entities.get('engine-config-affective-blender')
    if( !cfg ) return

    const p = cfg.metadata?.params as Record<string, number> | undefined
    if( !p ) return

    if( p.inertia           != null ) this._inertia           = p.inertia
    if( p.temperamentValence != null ) this._temperamentValence = p.temperamentValence
  }


  subscribes(): string[] {
    return [
      'circadian.state.changed',
      'energy.state.changed',
      'interoception.state.changed',
      'sleep.state.changed',
      'stress.state.changed',
      'executive.prediction.formed',
      'interaction.occurred',   // 2.1: social stimuli drive immediate arousal/valence shifts
    ]
  }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    switch( e.type ){
      case 'circadian.state.changed':
        this._moodBaseline = (e.payload as Record<string,number>)['moodBaseline'] ?? this._moodBaseline
        break
      case 'energy.state.changed':
        this._energyLevel = (e.payload as Record<string,number>)['level'] ?? this._energyLevel
        break
      case 'interoception.state.changed':
        this._comfort = (e.payload as Record<string,number>)['comfort'] ?? this._comfort
        break
      case 'sleep.state.changed':
        this._sleepPressure = (e.payload as Record<string,number>)['pressure'] ?? this._sleepPressure
        break
      case 'stress.state.changed':
        this._stressLoad = (e.payload as Record<string,number>)['load'] ?? this._stressLoad
        break
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if (p.predictedDomains.includes('energy'))
          this._model.setPrecision('affect.arousal', 1.0 + p.confidence * 0.3)
        break
      }
      case 'interaction.occurred': {
        // 2.1: Wire social events to immediate affective response.
        // Any directed interaction triggers an orienting response (arousal spike)
        // regardless of valence.  Valence shifts toward the interaction's tone.
        // Both signals decay automatically each tick in react().
        const p = e.payload as { valence: number; intensity: number; directedAtSelf: boolean }
        if( p.directedAtSelf || e.salience > 0.5 ){
          const intensity = Math.max( 0.3, p.intensity )
          // Arousal: social presence is activating — always rises, decays to 0
          this._socialArousalSurge = Math.min( 1, this._socialArousalSurge + intensity * 0.35 )
          // Valence: shifts toward interaction tone; capped to ±0.8 to stay blendable
          const shift = p.valence * intensity * 0.30
          this._socialValenceBump = Math.max( -0.8, Math.min( 0.8,
            this._socialValenceBump + shift
          ))
        }
        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {
    moodBaseline: this._moodBaseline,
    energyLevel: this._energyLevel,
    comfort: this._comfort,
    sleepPressure: this._sleepPressure,
    stressLoad: this._stressLoad,
    }
  }

  async react(
    _delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._readConfigFromState( state )
    
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { set: [], metrics: [] }

    // 1. Read all discrete emotions
    const emotionIntensities = new Map<string, number>()
    for( const key of EMOTION_KEYS ){
      const 
      shortName = key.replace('emotion.', ''),
      intensity = state.metrics.get( key ) ?? 0

      emotionIntensities.set( shortName, intensity )
    }

    // 2. Compute raw PAD from weighted emotion contributions
    const rawPAD = this._computeRawPAD( emotionIntensities )

    // 2b. Overlay transient social modulation — interaction.occurred events boost
    //     arousal (orienting response) and nudge valence toward the interaction tone.
    //     Applied before inertia so the surge is smoothed naturally, not applied cold.
    //     Both signals decay each tick toward zero.
    const socialPAD: PADState = {
      valence:   Math.max( -1, Math.min( 1, rawPAD.valence + this._socialValenceBump )),
      arousal:   Math.min( 1, rawPAD.arousal + this._socialArousalSurge ),
      dominance: rawPAD.dominance,
    }
    this._socialArousalSurge = Math.max( 0, this._socialArousalSurge - 0.05 )
    this._socialValenceBump *= 0.88

    // 2c. Overlay vicarious affect from empathy (emotion contagion) — resonating with
    //     others pulls the Will's own affect toward theirs. empathy.simulator already
    //     dampens by resonance × closeness, so it folds in with a modest weight. Before
    //     inertia so the contagion smooths naturally rather than being applied cold.
    const empathicPAD: PADState = {
      valence:   Math.max( -1, Math.min( 1, socialPAD.valence + ( state.metrics.get( 'empathy.vicarious_valence' ) ?? 0 ) * EMPATHY_CONTAGION_WEIGHT )),
      arousal:   Math.max( 0, Math.min( 1, socialPAD.arousal + ( state.metrics.get( 'empathy.vicarious_arousal' ) ?? 0 ) * EMPATHY_CONTAGION_WEIGHT )),
      dominance: socialPAD.dominance,
    }

    // 3. Apply emotional inertia (carryover from previous state)
    const blendedPAD = this._applyInertia( empathicPAD )

    // 4. Apply interoceptive modulation (body state colors emotion)
    const modulatedPAD = this._applyInteroceptiveModulation( blendedPAD, state )

    // 5. Store PAD state
    commands.metrics!.push(
      [ 'affect.valence', modulatedPAD.valence ],
      [ 'affect.arousal', modulatedPAD.arousal ],
      [ 'affect.dominance', modulatedPAD.dominance ],
    )

    // 6. Detect blending phenomena
    const blends = this._detectBlends( emotionIntensities )

    // 7. Identify dominant emotion
    const dominant = this._dominantEmotion( emotionIntensities )
    const dominantCode = DOMINANT_EMOTION_CODES[ dominant ?? 'neutral' ] ?? 0
    commands.metrics!.push([ 'affect.dominant_emotion', dominantCode ])

    // Persist active blends as a state entity so the executive bridge can read them
    commands.set!.push({
      id: 'affect-blends',
      type:     'affect.blends',
      metadata: { blends },
    })

    // 8. Track emotion history for blending detection
    this._updateHistory( emotionIntensities )

    // 9. Snapshot previous PAD BEFORE overwriting — needed for shift-event below
    const prevPAD = this._previousPAD
    this._previousPAD = { ...modulatedPAD }

    // Events
    if( blends.length > 0 && this._emitBlendEvents )
      events.push({
        type: 'affect.blend',
        source: this.name,
        payload: { blends, pad: modulatedPAD },
      })

    // Significant valence shift event — compare against the PAD from the last tick
    // (prevPAD), not the just-overwritten _previousPAD.
    if( Math.abs( modulatedPAD.valence - prevPAD.valence ) > 0.3 )
      events.push({
        type: 'affect.valence_shift',
        source: this.name,
        payload: {
          previous: prevPAD.valence,
          current: modulatedPAD.valence,
        },
      })


    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus )
      _bus.publish({ type: 'affect.state.shifted', version: 1, sourceEngine: this.name, salience: Math.min(1, Math.abs(modulatedPAD.valence) + modulatedPAD.arousal * 0.5), payload: { valence: modulatedPAD.valence, arousal: modulatedPAD.arousal, dominantEmotion: dominant } })
    // Phase D: rich state-change event
    if( _bus )
      _bus.publish({ type: 'affect.state.changed', version: 1, sourceEngine: this.name, salience: this._model.observe( 'affect.arousal', modulatedPAD.arousal ).salience, payload: { valence: modulatedPAD.valence, arousal: modulatedPAD.arousal, dominance: modulatedPAD.dominance } })
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── PAD computation ──────────────────────────────────────

  /**
   * Compute raw PAD state from discrete emotion intensities.
   * Each emotion contributes to PAD proportional to its intensity
   * and its established PAD coordinates.
   */
  private _computeRawPAD( emotions: Map<string, number> ): PADState {
    let totalValence = 0
    let totalArousal = 0
    let totalDominance = 0
    let totalWeight = 0

    for( const [ name, intensity ] of emotions ){
      if( intensity < 0.01 ) continue

      const pad = EMOTION_PAD[ name ]
      if( !pad ) continue

      const weight = intensity
      totalValence   += pad.valence   * weight
      totalArousal   += pad.arousal   * weight
      totalDominance += pad.dominance * weight
      totalWeight     += weight
    }

    if( totalWeight === 0 )
      return { valence: 0, arousal: 0.2, dominance: 0.5 }

    return {
      valence:   Math.max( -1, Math.min( 1, totalValence / totalWeight ) ),
      arousal:   Math.max( 0, Math.min( 1, totalArousal / totalWeight ) ),
      dominance: Math.max( 0, Math.min( 1, totalDominance / totalWeight ) ),
    }
  }

  /**
   * Apply emotional inertia — emotions don't flip instantly.
   * The higher the inertia, the more the previous state carries over.
   */
  private _applyInertia( raw: PADState ): PADState {
    // Gentle pull toward the long-term temperament set-point before inertia smoothing.
    // This models stable personality hedonic baseline (some Wills are naturally more
    // positive/negative) without overriding session affect.
    const TEMPERAMENT_PULL = 0.05
    const targetValence = raw.valence + TEMPERAMENT_PULL * ( this._temperamentValence - raw.valence )

    return {
      valence:   this._previousPAD.valence   + ( 1 - this._inertia ) * ( targetValence  - this._previousPAD.valence ),
      arousal:   this._previousPAD.arousal   + ( 1 - this._inertia ) * ( raw.arousal    - this._previousPAD.arousal ),
      dominance: this._previousPAD.dominance + ( 1 - this._inertia ) * ( raw.dominance  - this._previousPAD.dominance ),
    }
  }

  /**
   * Modulate PAD by interoceptive state.
   * The body state colors emotional experience:
   * - High sleep pressure dampens positive valence
   * - Low energy reduces arousal capacity
   * - High stress amplifies negative valence
   */
  private _applyInteroceptiveModulation( pad: PADState, state: ReadonlySimulationState ): PADState {
    const
    comfort       = this._comfort,
    sleepPressure = this._sleepPressure,
    stressLoad    = this._stressLoad,
    energyLevel   = this._energyLevel,
    moodBaseline  = this._moodBaseline

    // Comfort pulls valence toward center (discomfort dampens both joy and sadness)
    const comfortModulation = ( comfort - 0.5 ) * 0.3

    // High sleep pressure shifts valence negative
    const sleepModulation = -Math.max( 0, ( sleepPressure - 40 ) / 60 ) * 0.2

    // Circadian mood baseline shifts valence
    const moodModulation = ( moodBaseline - 0.5 ) * 0.25

    // Stress amplifies arousal and shifts valence negative
    const stressModulation = -( stressLoad / 100 ) * 0.3

    // Energy caps maximum arousal (can't be highly aroused when exhausted)
    const energyArousalCap = Math.min( 1, energyLevel / 50 )

    return {
      valence: Math.max( -1, Math.min( 1,
        pad.valence + comfortModulation + sleepModulation + moodModulation + stressModulation
      )),
      arousal: Math.min( energyArousalCap, pad.arousal + ( stressLoad / 100 ) * 0.2 ),
      dominance: pad.dominance,
    }
  }

  // ── Blending detection ───────────────────────────────────

  /**
   * Detect co-occurring emotions that produce blend phenomena.
   */
  private _detectBlends( emotions: Map<string, number> ): string[] {
    const blends: string[] = []

    // Bittersweet: joy + sadness both present
    if( ( emotions.get('joy') ?? 0 ) > 0.3 && ( emotions.get('sadness') ?? 0 ) > 0.3 )
      blends.push('bittersweet')

    // Anxious excitement: excitement + anxiety
    if( ( emotions.get('excitement') ?? 0 ) > 0.4 && ( emotions.get('anxiety') ?? 0 ) > 0.3 )
      blends.push('anxious_excitement')

    // Guilty pleasure: joy + guilt
    if( ( emotions.get('joy') ?? 0 ) > 0.4 && ( emotions.get('guilt') ?? 0 ) > 0.3 )
      blends.push('guilty_pleasure')

    // Awed fear: awe + fear (sublime experience)
    if( ( emotions.get('awe') ?? 0 ) > 0.5 && ( emotions.get('fear') ?? 0 ) > 0.3 )
      blends.push('sublime')

    // Righteous anger: anger + pride (indignation already captures this)
    if( ( emotions.get('anger') ?? 0 ) > 0.4 && ( emotions.get('pride') ?? 0 ) > 0.4 )
      blends.push('righteous_anger')

    // Nostalgic sadness: sadness + love (missing something cherished)
    if( ( emotions.get('sadness') ?? 0 ) > 0.3 && ( emotions.get('love') ?? 0 ) > 0.4 )
      blends.push('nostalgia')

    // Curiosity-fear: curiosity + fear (cautious exploration)
    if( ( emotions.get('curiosity') ?? 0 ) > 0.4 && ( emotions.get('fear') ?? 0 ) > 0.3 )
      blends.push('cautious_curiosity')

    return blends
  }

  /**
   * Find the most intense emotion.
   */
  private _dominantEmotion( emotions: Map<string, number> ): string | null {
    let maxIntensity = 0.1  // Threshold — below this, no clear dominant
    let dominant: string | null = null

    for( const [ name, intensity ] of emotions ){
      if( intensity > maxIntensity ){
        maxIntensity = intensity
        dominant = name
      }
    }

    return dominant
  }

  private _updateHistory( emotions: Map<string, number> ): void {
    for( const [ name, intensity ] of emotions ){
      const history = this._emotionHistory.get( name ) ?? []
      history.push( intensity )
      if( history.length > 10 ) history.shift()
      this._emotionHistory.set( name, history )
    }
  }
}
// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/attention.allocator.ts
// ─────────────────────────────────────────────────────────────

/**
 * AttentionAllocator — manages a finite attention budget.
 *
 * Attention is a limited resource. Attending to entities consumes
 * budget. Salient stimuli (from Perception) compete for allocation.
 * Multiple simultaneous demands cause fragmentation (reduced depth).
 *
 * Receives modulation from:
 *   - EnergyRegulator (low energy → reduced capacity)
 *   - SleepPressureRegulator (fatigue → reduced capacity)
 *   - CircadianOscillator (time-of-day capacity variation)
 *
 * Part of Shard 0 (Regulatory Layer) — runs every tick, synchronous.
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
import { ACP_SELF_PRECISION } from '#cognition/acp'
import { readEffectiveParams } from '#cognition/persona.prior'

export interface AttentionAllocatorConfig {
  /** Maximum attention capacity (baseline, before modulation) */
  maxCapacity?: number
  /** Cost per tick to maintain attention on a single focus */
  costPerFocus?: number
  /** Maximum number of simultaneous attention foci */
  maxFoci?: number
  /** How quickly attention shifts between foci (lower = more sticky) */
  shiftInertia?: number
  bus?: CognitiveBus
}

interface AttentionFocus {
  entityId: string
  depth: number         // 0-1: how deeply attended this focus is
  duration: number      // ticks this focus has been maintained
  salienceAtCapture: number
}

// ── Voluntary attention effort (Option C) ─────────────────────
// `effort` is how much of the vitals-permitted capacity ceiling the mind chooses
// to engage. The executive sets it explicitly via its action vocabulary (a
// `focus` action mobilizes; `rest`/`sleep`/`wait`/`meditate` stand down); absent
// a choice it relaxes back to baseline, so focus/rest are transient unless
// renewed. Effort scales the ceiling, so vitals always win — you cannot focus
// past exhaustion (a collapsed ceiling leaves nothing to engage).
// ── ACP-P2 (ACTION_CONDITIONED_PREDICTION §3) — efferent anticipation ────────
/** Expected attention-usage swing right after our own enaction. */
const ACP_USAGE_UPLIFT = 0.15
/** Conservative anticipation confidence (plan of record: 0.3–0.5). */
const ACP_CONFIDENCE = 0.4
/**
 * Self-caused precision: measurement showed that after a stable stretch the
 * salience denominator (EW variance) collapses, so ANY deviation saturates
 * salience at 1.0 and a conservative anticipation nudge is invisible there.
 * The measurable lever at this seam is precision (salience = base × precision,
 * executive precedent at 'executive.prediction.formed'): our own action's
 * swing carries reduced attention-grabbing weight — below the workspace gate
 * (WORKSPACE_THRESHOLD = 0.4) even when the base saturates. Restored
 * explicitly after ONE observe (GenerativeModel's own mean-reversion is
 * 0.02/observe ≈ 50 ticks — that lingering would suppress genuine world
 * surprise arriving after our action, the exact failure the plan forbids).
 */
// (moved to #cognition/acp — shared across ACP-P2 consumers)

const EFFORT_BASELINE = 0.7   // homeostatic default utilization of the ceiling
const EFFORT_MIN      = 0.4   // deepest voluntary stand-down (rest)
const EFFORT_MAX      = 1.0   // full mobilization (focus)
const EFFORT_RELAX    = 0.05  // fraction of the gap-to-baseline relaxed per tick

// ── Arousal-driven ceiling (Option A — involuntary upward lever) ──────────────
// Threat/reward arousal (the integrated `affect.arousal`) mobilizes capacity
// ABOVE baseline — fight-or-flight — but with a Yerkes–Dodson inverted-U: moderate
// arousal lifts the ceiling, while extreme arousal collapses it (fragmentation /
// tunnel vision). This is the involuntary counterpart to voluntary focus: it
// raises the ceiling effort utilizes, so a calm mind sits at baseline, a roused
// one can engage more, and a panicked one loses capacity it cannot will back.
const AROUSAL_REST     = 0.3   // at/below this — calm; no mobilization (factor 1.0)
const AROUSAL_PEAK     = 0.65  // optimal arousal — maximum mobilization
const AROUSAL_GAIN     = 0.3   // peak upward mobilization (+30% ceiling at the peak)
const AROUSAL_OVERLOAD = 0.4   // impairment at maximum arousal (factor → 1 − 0.4)

export class AttentionAllocator implements SimulationEngine, CognitiveEngine {
  readonly name     = 'attention-allocator'
  
  private _maxCapacity: number
  private _costPerFocus: number
  private _maxFoci: number
  private _shiftInertia: number
  private _activeFocus: AttentionFocus[] = []

  private _energyLevel: number = 100
  private _sleepPressure: number = 0

  /** Voluntary effort set-point (0.4–1.0); see EFFORT_* constants. */
  private _effort: number = EFFORT_BASELINE
  /** A one-shot focus/rest request from the executive, applied next react(). */
  private _effortRequest: number | null = null
  /** ACP-P2: a self-caused precision attenuation is armed; react() restores after one observe. */
  private _acpOneShot = false

  private _bus: CognitiveBus | null = null

  private readonly _model    = new GenerativeModel()


  constructor( config: AttentionAllocatorConfig = {} ){
    this._bus = config.bus ?? null
    this._maxCapacity  = config.maxCapacity  ?? 100
    this._costPerFocus = config.costPerFocus ?? 5
    this._maxFoci      = config.maxFoci      ?? 4
    this._shiftInertia = config.shiftInertia ?? 0.7
  }
  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────


  subscribes(): string[] {
    return [
      'energy.state.changed',
      'sleep.state.changed',
      'executive.prediction.formed',
      'attention.regulate',   // voluntary focus/rest from the executive (Option C)
      'senses.*',   // all sense percepts — salience feeds attention allocation
      // ACP-P2: our own enactions — anticipate the attention swing they cause
      'agency.enacted', 'agency.communicate', 'agency.invocation',
    ]
  }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    switch( e.type ){
      case 'energy.state.changed':
        this._energyLevel = (e.payload as Record<string,number>)['level'] ?? this._energyLevel
        break
      case 'sleep.state.changed':
        this._sleepPressure = (e.payload as Record<string,number>)['pressure'] ?? this._sleepPressure
        break
      case 'attention.regulate': {
        // Voluntary focus/rest (Option C). Clamp the requested set-point; react()
        // applies it next tick and then decays it back toward baseline.
        const t = (e.payload as Record<string,number>)['effortTarget']
        if( typeof t === 'number')
          this._effortRequest = Math.min( EFFORT_MAX, Math.max( EFFORT_MIN, t ) )
        break
      }
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('attention') )
          this._model.setPrecision('attention.usage', 1.0 + p.confidence * 0.5 )
        break
      }
      case 'agency.enacted':
      case 'agency.communicate':
      case 'agency.invocation': {
        // ACP-P2, first consumer: we just acted — our own attention state is
        // about to move BECAUSE of it (usage up, free fraction down). Pre-blend
        // that expectation so the self-caused swing lands with low prediction
        // error and doesn't fire `attention.state.changed` as surprise; the
        // world's own deviations still do. One-shot by construction — the
        // anticipation weight is consumed by each stream's next observe().
        // Only the two streams whose errors are actually consumed (they gate
        // the publish) are anticipated; `attention.entity.*` errors are
        // discarded today, so anticipating them would be theater.
        const usage = this._model.predict('attention.usage')
        const free  = this._model.predict('attention.free_fraction')
        this._model.anticipate('attention.usage',         Math.min( 1, usage + ACP_USAGE_UPLIFT ), ACP_CONFIDENCE )
        this._model.anticipate('attention.free_fraction', Math.max( 0, free  - ACP_USAGE_UPLIFT ), ACP_CONFIDENCE )
        // The measurable half (see ACP_SELF_PRECISION): the next observe of
        // each stream carries self-caused weight; react() restores after one.
        this._model.setPrecision('attention.usage',         ACP_SELF_PRECISION )
        this._model.setPrecision('attention.free_fraction', ACP_SELF_PRECISION )
        this._acpOneShot = true
        break
      }
      default:
        // senses.*.percept — use the event's pre-computed salience as an
        // attention signal for the percept's source entity.
        if( e.type.startsWith('senses.') ){
          const percept = e.payload as { sourceEntityId?: string; salience?: number }
          if( percept.sourceEntityId )
            this._model.observe(`attention.entity.${percept.sourceEntityId}`, e.salience )
        }
        break
    }
  }

  snapshot(): Record<string, unknown> {
    return {
    energyLevel: this._energyLevel,
    sleepPressure: this._sleepPressure,
    effort: this._effort,
    }
  }

  async react(
    delta: Duration,
    _tick: Tick,
    state: ReadonlySimulationState,
    context: SimulationContext
  ): Promise<EngineResult> {
    this._readConfigFromState( state )
    
    const
    events:   Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = [],
    commands: StateCommands = { metrics: [] }

    // Voluntary effort (Option C): an explicit focus/rest request snaps the
    // set-point; otherwise it relaxes toward the homeostatic baseline so focus/
    // rest fade unless renewed each cycle.
    if( this._effortRequest != null ){
      this._effort = this._effortRequest
      this._effortRequest = null
    }
    else
      this._effort += ( EFFORT_BASELINE - this._effort ) * EFFORT_RELAX
    this._effort = Math.min( EFFORT_MAX, Math.max( EFFORT_MIN, this._effort ) )

    // Apply modulations to capacity — derived from regulatory metrics directly
    // (modulation events are not routed as metrics, so we compute factors here).
    // The CEILING (what the body permits) is set by the vitals AND arousal:
    // energy/sleep can collapse it to forced rest/shutdown; arousal (fight-or-
    // flight) can lift it above baseline, or — at the extreme — collapse it via
    // fragmentation. Effort then scales how much of that ceiling is engaged.
    const
    energyLevel      = this._energyLevel,
    sleepPressure    = this._sleepPressure,
    arousal          = state.metrics.get('affect.arousal') ?? AROUSAL_REST,
    energyFactor     = energyLevel < 30 ? 0.3 + ( energyLevel / 30 ) * 0.7 : 1.0,
    sleepFactor      = sleepPressure > 40
                         ? 1 - ( ( sleepPressure - 40 ) / 60 ) * 0.5
                         : 1.0,
    arousalFactor    = this._arousalFactor( arousal ),
    ceiling           = this._maxCapacity * energyFactor * sleepFactor * arousalFactor,
    effectiveCapacity = ceiling * this._effort

    // Get incoming salience signals (entities demanding attention)
    const salienceMap = this._extractSalienceSignals( state )

    // Decay existing focuses (attention fades if not reinforced)
    this._decayFocuses( delta )

    // Allocate attention: balance new salience vs. existing focus inertia
    this._allocate( salienceMap, effectiveCapacity )

    // Compute attention metrics
    const
    totalAllocated  = this._activeFocus.reduce( ( s, f ) => s + f.depth * this._costPerFocus, 0 ),
    attentionUsage  = effectiveCapacity > 0 ? totalAllocated / effectiveCapacity : 0,
    focusCount      = this._activeFocus.length,
    deepestFocus    = this._activeFocus.reduce( ( best, f ) => f.depth > best.depth ? f : best, { depth: 0 } as AttentionFocus )

    const
    freeCapacity = Math.max( 0, effectiveCapacity - totalAllocated ),
    // Normalized 0–1 spare-attention fraction vs the BASELINE capacity — the
    // signal the FacetSupervisor budgets on. Normalizing by baseline (not the
    // already-modulated effectiveCapacity) is what makes vital-reduced capacity
    // (low energy / high sleep pressure) actually shrink the facet budget,
    // instead of the raw 0–100 capacity inflating it ~100× so it never binds.
    freeFraction = this._maxCapacity > 0 ? Math.max( 0, freeCapacity / this._maxCapacity ) : 0,
    isIdle       = attentionUsage < 0.2 ? 1 : 0

    commands.metrics!.push(
      [ 'attention.usage', attentionUsage ],
      [ 'attention.focus_count', focusCount ],
      [ 'attention.capacity', effectiveCapacity ],
      [ 'attention.free_capacity', freeCapacity ],
      [ 'attention.free_fraction', freeFraction ],
      [ 'attention.effort', this._effort ],
      [ 'attention.arousal_factor', arousalFactor ],
      [ 'attention.idle', isIdle ],
    )

    // Collect all stale attention.focus entities to replace them cleanly
    const staleIds: string[] = []
    for( const [ id, entity ] of state.entities ){
      if( entity.type === 'attention.focus')
        staleIds.push( id )
    }

    // Persist current attention foci as entities (for other engines to read)
    if( this._activeFocus.length > 0 ){
      commands.set = this._activeFocus.map( f => ({
        id: `attention-focus-${f.entityId}`,
        type:     'attention.focus',
        metadata: {
          entityId: f.entityId,
          depth: f.depth,
          duration: f.duration,
        },
      }))

      commands.delete = staleIds.filter( id => !this._activeFocus.some( f => `attention-focus-${f.entityId}` === id ) )
    }
    else {
      commands.set = [{
        id: 'attention-focus-none',
        type:     'attention.focus',
        metadata: { entityId: null, depth: 0, duration: 0 },
      }]
      commands.delete = staleIds.filter( id => id !== 'attention-focus-none')
    }

    // Event when attention shifts significantly
    if( focusCount === 0 && this._activeFocus.length > 0 )
      events.push({
        type: 'attention.engaged',
        source: this.name,
        payload: { focus: deepestFocus.entityId, depth: deepestFocus.depth },
      })

    if( focusCount > 2 )
      events.push({
        type: 'attention.fragmented',
        source: this.name,
        payload: { focusCount, usage: attentionUsage },
      })


    // Phase C: publish cognitive event
    const _bus = this._bus
    if( _bus && attentionUsage > 0.8 )
      _bus.publish({ type: 'working_memory.capacity.reached', version: 1, sourceEngine: this.name, salience: Math.min(1, attentionUsage), payload: { usage: attentionUsage, focusCount } })
    // Phase D + F: rich state-change event — gated by prediction error on EITHER
    // usage OR free fraction. Gating on free fraction too is what lets a voluntary
    // effort change (focus/rest) reach the FacetSupervisor even when perceptual
    // load — and thus usage — is steady; otherwise the budget would not move in a
    // quiet mind.
    if( _bus ){
      const usageErr = this._model.observe('attention.usage', attentionUsage )
      const freeErr  = this._model.observe('attention.free_fraction', freeFraction )
      // ACP-P2: the self-caused observe has happened — restore full precision
      // immediately so a genuine world surprise NEXT tick is not dampened
      // (the model's own mean-reversion would take ~50 observes).
      if( this._acpOneShot ){
        this._model.setPrecision('attention.usage',         1.0 )
        this._model.setPrecision('attention.free_fraction', 1.0 )
        this._acpOneShot = false
      }
      if( !usageErr.gated || !freeErr.gated )
        _bus.publish({ type: 'attention.state.changed', version: 1, sourceEngine: this.name, salience: Math.max( usageErr.salience, freeErr.salience ), payload: { usage: attentionUsage, focusCount, capacity: effectiveCapacity, freeFraction } })
    }
    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Config hot-reload ────────────────────────────────────

  private _readConfigFromState( state: ReadonlySimulationState ): void {
    // Effective config = base engine-config-attention ⊕ persona-prior (single-source).
    // The persona-consolidator lowers shiftInertia on belief-formation bias (edge 8)
    // → attention shifts more readily, loosening the fixation that feeds the bias.
    const p = readEffectiveParams( state, 'engine-config-attention')
    if( p.maxCapacity  != null ) this._maxCapacity  = p.maxCapacity
    if( p.costPerFocus != null ) this._costPerFocus = p.costPerFocus
    if( p.maxFoci      != null ) this._maxFoci      = p.maxFoci
    if( p.shiftInertia != null ) this._shiftInertia = p.shiftInertia
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Yerkes–Dodson arousal → ceiling factor. Calm (≤ AROUSAL_REST) → 1.0 (no
   * boost); rises linearly to 1 + AROUSAL_GAIN at AROUSAL_PEAK (mobilization);
   * then declines below 1 toward 1 − AROUSAL_OVERLOAD at maximum arousal
   * (fragmentation / tunnel vision — capacity the mind cannot will back).
   */
  private _arousalFactor( arousal: number ): number {
    const a = Math.min( 1, Math.max( 0, arousal ) )
    if( a <= AROUSAL_REST ) return 1.0
    if( a <= AROUSAL_PEAK )
      return 1 + AROUSAL_GAIN * ( ( a - AROUSAL_REST ) / ( AROUSAL_PEAK - AROUSAL_REST ) )
    return ( 1 + AROUSAL_GAIN ) - ( AROUSAL_GAIN + AROUSAL_OVERLOAD ) * ( ( a - AROUSAL_PEAK ) / ( 1 - AROUSAL_PEAK ) )
  }

  /**
   * Extract salience signals from perceptual entities.
   * Entities with higher salience demand more attention.
   */
  private _extractSalienceSignals( state: ReadonlySimulationState ): Map<string, number> {
    const salienceMap = new Map<string, number>()

    for( const [ id, entity ] of state.entities ){
      if( entity.type === 'percept' && entity.metadata?.salience !== undefined )
        salienceMap.set( id, entity.metadata.salience as number )

      // Also check for explicit attention demands (urgent events)
      if( entity.type === 'attention.demand')
        salienceMap.set( id, ( entity.metadata?.urgency as number ) ?? 0.5 )
    }

    return salienceMap
  }

  /**
   * Decay existing attention focuses over time.
   * Sustained attention on a single focus resists decay (vigilance effect).
   */
  private _decayFocuses( delta: Duration ): void {
    const decayRate = 0.01 * ( delta / 1000 )

    this._activeFocus = this._activeFocus
      .map( f => ({
        ...f,
        // Sustained focus decays slower (inertia)
        depth: Math.max( 0, f.depth - decayRate * ( 1 - this._shiftInertia * Math.min( 1, f.duration / 100 ) ) ),
        duration: f.duration + 1,
      }))
      .filter( f => f.depth > 0.01 )  // Prune negligible focuses
  }

  /**
   * Allocate attention budget across competing salience signals.
   * Balances capturing new salient stimuli against maintaining existing focus.
   */
  private _allocate( salienceMap: Map<string, number>, capacity: number ): void {
    if( salienceMap.size === 0 ) return

    // Sort by salience (highest first)
    const sorted = Array.from( salienceMap.entries() )
      .sort( ( a, b ) => b[1] - a[1] )

    // Allocate to top-K salient entities (respecting max foci)
    const allocated: AttentionFocus[] = []
    let remainingCapacity = capacity

    for( const [ entityId, salience ] of sorted ){
      if( allocated.length >= this._maxFoci ) break

      // Check if this entity already has attention
      const existing = this._activeFocus.find( f => f.entityId === entityId )

      if( existing ){
        // Maintain existing focus — reinforce with salience
        const reinforcedDepth = Math.min( 1, existing.depth + salience * 0.2 )
        const cost = reinforcedDepth * this._costPerFocus

        if( cost <= remainingCapacity ){
          allocated.push({ ...existing, depth: reinforcedDepth })
          remainingCapacity -= cost
        }
      }
      else {
        // New focus — cost of shifting attention
        const shiftCost = this._costPerFocus * ( 1 + this._shiftInertia )
        const initialDepth = Math.min( 0.5, salience )

        if( shiftCost + initialDepth * this._costPerFocus <= remainingCapacity ){
          allocated.push({
            entityId,
            depth: initialDepth,
            duration: 0,
            salienceAtCapture: salience,
          })
          remainingCapacity -= shiftCost + initialDepth * this._costPerFocus
        }
      }
    }

    this._activeFocus = allocated
  }
}
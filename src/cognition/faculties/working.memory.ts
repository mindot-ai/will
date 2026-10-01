// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/working.memory.ts
// ─────────────────────────────────────────────────────────────

/**
 * WorkingMemory — limited-capacity active buffer for current cognition.
 *
 * Holds:
 *   - Current percepts (from perceptual engines)
 *   - Active goals (from executive layer)
 *   - Retrieved episodic memories (from long-term store)
 *   - Current affective state
 *
 * Properties:
 *   - Capacity-limited (7 ± 2 chunks by default)
 *   - Rapid decay without rehearsal (items fade in ~2-10 seconds)
 *   - Attentional boost (attended items resist decay)
 *   - Chunking (related items can be grouped into single slots)
 *   - Recency effect (newest items displace oldest when at capacity — and among
 *     things that arrive together, the most salient win the slots)
 *
 * Receives modulation from:
 *   - SleepPressureRegulator (fatigue reduces capacity)
 *   - StressRegulator (overload reduces effective capacity)
 *   - CircadianOscillator (alertness modulates rehearsal strength)
 *
 * Part of Shard 0 — runs every tick, synchronous.
 */

import type {
  Duration,
  Tick,
  SimulationContext,
  ReadonlySimulationState,
  StateCommands,
  SimulationEvent,
  SimulationEntity,
} from '#core/types'
import type { SimulationEngine, EngineResult, CognitiveEngine } from '#cognition/types'
import type { CognitiveEvent, CognitiveBus } from '#cognition/bus'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import { GenerativeModel } from '#cognition/generative.model'
import { readEffectiveParams } from '#cognition/persona.prior'

export interface WorkingMemoryConfig {
  /** Maximum chunks in working memory (default 7, Miller's Law) */
  maxChunks?: number
  /** Base decay rate per second (0-1, fraction of activation lost) */
  baseDecayRate?: number
  /** How much attention focus slows decay (0-1, 0 = no protection) */
  attentionProtection?: number
  /** Threshold below which an item is dropped */
  retrievalThreshold?: number
  /** Whether to emit detailed WM events */
  emitEvents?: boolean
  bus?: CognitiveBus
}

interface WMItem {
  id: string
  type: string          // 'percept', 'goal', 'memory', 'thought'
  content: unknown
  activation: number    // 0-1: current activation strength
  attendedAt: Tick[]    // recent ticks where this item had attention
  createdAt: Tick
  sourceEntityId?: string
  tags: string[]
  /** A percept's salience when it arrived — breaks ties between equally active items. */
  salience?: number
  /** The activation it was encoded with — what consolidation weighs (see _persistItems). */
  encoding?: number
}

/** A percept enters working memory at this activation, whatever its salience. */
const PERCEPT_ACTIVATION = 0.75

/** Is `a` weaker than `b`? Activation first; between equals, the less salient. */
const weaker = ( a: WMItem, b: WMItem ): boolean =>
  a.activation < b.activation || ( a.activation === b.activation && ( a.salience ?? 0 ) < ( b.salience ?? 0 ) )

export class WorkingMemory implements SimulationEngine, CognitiveEngine {
  readonly name     = 'working-memory'
  
  private _maxChunks:           number
  private _baseDecayRate:       number
  private _attentionProtection: number
  private _retrievalThreshold:  number
  private _emitEvents:          boolean

  private _items: WMItem[] = []
  /** Percepts that have already competed for a slot — each competes once. */
  private _consideredPercepts = new Set<string>()
  private _modulatedCapacity: number
  private _activeGoalCount  = 0

  /**
   * Monotonic suffix counter for injected WM item ids. Replaces Math.random()
   * AND the former `Date.now()` component so a run replays identically (R2).
   * Unique per engine instance, which is sufficient for WM item ids.
   */
  private _idSeq = 0

  private _bus: CognitiveBus | null = null
  private readonly _model = new GenerativeModel()

  constructor( config: WorkingMemoryConfig = {} ){
    this._bus                 = config.bus ?? null
    this._maxChunks           = config.maxChunks           ?? 7
    this._baseDecayRate       = config.baseDecayRate       ?? 0.08
    this._attentionProtection = config.attentionProtection ?? 0.6
    this._retrievalThreshold  = config.retrievalThreshold  ?? 0.05
    this._emitEvents          = config.emitEvents          ?? false
    this._modulatedCapacity   = this._maxChunks
  }

  attachBus( bus: CognitiveBus ): void { this._bus = bus }

  // ── Engine interface ─────────────────────────────────────


  // `attention.focus.changed` used to be listed here as the "preferred" focus source.
  // Nothing has ever published it — focus reaches this engine through the
  // `attention.focus` STATE ENTITY that AttentionAllocator writes, read in
  // _applyAttention, and capacity is modulated from circadian alertness in _react.
  // Both live paths have the same source, so the subscription was pure redundancy
  // that read as a live wire. Removed rather than published (#114).
  subscribes(): string[] {
    return [
      'goal.state.changed',
      'executive.prediction.formed',
    ]
  }
  publishes(): CognitiveEventSchema[] { return [] }

  onCognitiveEvent( e: CognitiveEvent ): StateCommands | void {
    this._model.observe( e.type, e.salience )
    switch( e.type ){
      case 'goal.state.changed': {
        const p = e.payload as Record<string, number>
        if( p['activeCount'] != null ) this._activeGoalCount = p['activeCount']
        break
      }
      case 'executive.prediction.formed': {
        const p = e.payload as { predictedDomains: string[]; confidence: number }
        if( p.predictedDomains.includes('memory') )
          this._model.setPrecision('memory.working.load', 1.0 + p.confidence * 0.5 )
        break
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      items:        this._items.length,
      modulatedCap: this._modulatedCapacity,
      activeGoals:  this._activeGoalCount,
    }
  }

  // ── Public API ───────────────────────────────────────────

  /** Returns all active WM items sorted by activation descending. */
  getItems(): WMItem[] {
    return [ ...this._items ].sort( ( a, b ) => b.activation - a.activation )
  }

  /** Returns all active WM items of a given type, sorted by activation descending. */
  getItemsByType( type: string ): WMItem[] {
    return this._items
      .filter( i => i.type === type )
      .sort( ( a, b ) => b.activation - a.activation )
  }

  /** Inject an item directly (used by integration tests and episodic retrieval). */
  load( item: Omit<WMItem, 'id' | 'createdAt'> & { createdAt?: Tick } ): void {
    const id = `wm-${( this._idSeq++ ).toString( 36 )}`
    const createdAt = item.createdAt ?? 0
    this._evictIfNeeded()
    this._items.push({ encoding: item.activation, ...item, id, createdAt })
  }

  /**
   * Effective config = base engine-config-working-memory ⊕ persona-prior (single-source).
   * No-op at boot: mirror params equal the constructor defaults (reconciled in #83).
   */
  private _readConfigFromState( state: ReadonlySimulationState ): void {
    const p = readEffectiveParams( state, 'engine-config-working-memory')
    if( p.maxChunks           != null ) this._maxChunks           = p.maxChunks
    if( p.baseDecayRate       != null ) this._baseDecayRate       = p.baseDecayRate
    if( p.attentionProtection != null ) this._attentionProtection = p.attentionProtection
    if( p.retrievalThreshold  != null ) this._retrievalThreshold  = p.retrievalThreshold
  }

  async react(
    delta: Duration,
    tick: Tick,
    state: ReadonlySimulationState,
    _context: SimulationContext
  ): Promise<EngineResult> {
    const commands: StateCommands = { set: [], delete: [], metrics: [] }
    const events: Array<Omit<SimulationEvent, 'id' | 'timestamp' | 'tick'>> = []

    // Effective config = base engine-config-working-memory ⊕ persona-prior (single-source).
    this._readConfigFromState( state )

    // Effective capacity: modulated by fatigue / stress signals from state
    const fatigue   = state.metrics.get('modulation.sleep_fatigue')   ?? 0
    const stress    = state.metrics.get('modulation.stress_overload') ?? 0
    const alertness = 1 - Math.max( fatigue, stress ) * 0.4
    this._modulatedCapacity = Math.max( 3, Math.round( this._maxChunks * alertness ) )

    // Ingest new content from state
    this._ingestPercepts( state, tick )
    this._ingestGoals( state, tick )

    // Apply attention focus — boosts attendedAt for the currently focused item
    this._applyAttention( state, tick )

    // Decay all items
    const deltaSeconds = delta / 1000
    for( const item of this._items ){
      const isAttended = item.attendedAt.includes( tick - 1 )
      const decayRate  = isAttended
        ? this._baseDecayRate * ( 1 - this._attentionProtection )
        : this._baseDecayRate
      item.activation = Math.max( 0, item.activation - decayRate * deltaSeconds )
    }

    // Active rehearsal — items with sustained attention resist decay
    this._rehearseItems()

    // Drop items below threshold
    const before = this._items.length
    this._items   = this._items.filter( i => i.activation >= this._retrievalThreshold )
    const dropped = before - this._items.length

    // Persist items as state entities + clean up stale ones
    this._persistItems( tick, state, commands )

    // Metrics
    const load = this._items.length / this._maxChunks
    commands.metrics!.push(
      [ 'memory.working.load',     load ],
      [ 'memory.working.capacity', this._modulatedCapacity ],
      [ 'memory.working.items',    this._items.length ],
    )

    // Bus events
    if( this._bus ){
      this._bus.publish({
        type: 'memory.working.changed',
        version: 1,
        sourceEngine: this.name,
        salience: this._model.observe('memory.working.load', load ).salience,
        payload: { items: this._items.length, capacity: this._modulatedCapacity, load },
      })

      if( this._emitEvents && this._items.length >= this._modulatedCapacity ){
        this._bus.publish({
          type: 'working_memory.full',
          version: 1,
          sourceEngine: this.name,
          salience: 0.7,
          payload: { capacity: this._modulatedCapacity, items: this._items.length },
        })
      }
    }

    if( this._emitEvents && dropped > 0 ){
      events.push({
        type: 'working.memory.overflow',
        source: this.name,
        payload: { dropped, remaining: this._items.length },
      })
    }

    return { events: events.length > 0 ? events : undefined, commands }
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Read the latest percept entities from state and inject them as WM items.
   * Skips generic placeholder summaries to avoid noise.
   *
   * Each percept competes for a slot once, the most salient first, and takes one
   * only from something weaker than itself. Every newcomer used to be admitted by
   * evicting the FIRST least-active item — in a batch that all arrives at the same
   * activation, the one admitted before it, i.e. the more salient one. Given
   * twenty percepts the buffer kept the seven least salient (0.05–0.35) and lost
   * everything above 0.4; and the evicted, still in state for two more ticks, were
   * re-admitted each tick against items that had since decayed, so the churn
   * repeated. Capacity, decay and recency are unchanged: a fresh percept still
   * displaces anything that has faded, and nothing that is attended.
   */
  private _ingestPercepts( state: ReadonlySimulationState, tick: Tick ): void {
    const fresh: Array<{ entity: SimulationEntity; summary: string; salience: number }> = []
    const present = new Set<string>()

    for( const entity of state.entities.values() ){
      if( entity.type !== 'percept') continue
      present.add( entity.id )
      if( this._consideredPercepts.has( entity.id ) ) continue
      this._consideredPercepts.add( entity.id )
      if( this._items.some( i => i.sourceEntityId === entity.id ) ) continue

      const summary = ( entity.metadata?.summary ?? entity.metadata?.content ?? '') as string
      if( !summary || summary.startsWith('New percept:') ) continue

      const salience = typeof entity.metadata?.salience === 'number' ? entity.metadata.salience : 0
      fresh.push({ entity, summary, salience })
    }

    // Percepts are swept from state after two ticks; forget having seen them then.
    for( const id of this._consideredPercepts )
      if( !present.has( id ) ) this._consideredPercepts.delete( id )

    fresh.sort( ( a, b ) => b.salience - a.salience || ( a.entity.id < b.entity.id ? -1 : a.entity.id > b.entity.id ? 1 : 0 ) )

    for( const { entity, summary, salience } of fresh ){
      if( this._items.length >= this._modulatedCapacity ){
        const at = this._weakestIndex()
        const candidate = { activation: PERCEPT_ACTIVATION, salience } as WMItem
        // Sorted, so nothing after this one would win either.
        if( !weaker( this._items[at]!, candidate ) ) break
        this._items.splice( at, 1 )
      }
      this._items.push({
        id: `wm-percept-${entity.id}`,
        type: 'percept',
        // The data too, not only the label. A percept entity is swept after 2
        // ticks; WM is where it is remembered, and remembering a sentence about
        // the evidence instead of the evidence is how a mind ends up unable to
        // answer a question it already had the answer to.
        content: { summary, entityId: entity.id,
                   ...( entity.metadata?.data !== undefined ? { data: entity.metadata.data } : {} ),
                   // How it arrived, so a memory of it can say — "what I found by acting"
                   // is a different thing to remember than news from the world.
                   ...( typeof entity.metadata?.provenance === 'string' ? { provenance: entity.metadata.provenance } : {} ),
                   ...( typeof entity.metadata?.sourceIntentId === 'string' ? { sourceIntentId: entity.metadata.sourceIntentId } : {} ) },
        activation: PERCEPT_ACTIVATION,
        encoding: PERCEPT_ACTIVATION,
        attendedAt: [],
        createdAt: tick,
        sourceEntityId: entity.id,
        tags: [ 'percept', ...(( entity.metadata?.tags as string[] ) ?? []) ],
        salience,
      })
    }
  }

  /**
   * Read active goal entities from state and ensure each has a WM slot.
   * Goal items start at 0.65 activation — lower than percepts, higher than background.
   */
  private _ingestGoals( state: ReadonlySimulationState, tick: Tick ): void {
    for( const entity of state.entities.values() ){
      if( entity.type !== 'goal') continue
      if( entity.metadata?.status !== 'active') continue
      if( this._items.some( i => i.sourceEntityId === entity.id ) ) continue

      this._evictIfNeeded()
      this._items.push({
        id: `wm-goal-${entity.id}`,
        type: 'goal',
        content: {
          description: entity.metadata?.description ?? entity.metadata?.name ?? entity.id,
          priority:    entity.metadata?.priority ?? 0.5,
        },
        activation: 0.65,
        encoding: 0.65,
        attendedAt: [],
        createdAt: tick,
        sourceEntityId: entity.id,
        tags: [ 'goal', 'executive' ],
      })
    }
  }

  /**
   * Mark the currently focused entity's WM item as attended this tick, from the
   * `attention.focus` entities AttentionAllocator writes. (A second, bus-driven
   * branch used to sit above this one, labelled "preferred"; the event behind it was
   * never published, so this loop has always been the only path — see #114.)
   *
   * And this path was dark too, from v0.1.0: AttentionAllocator names what it is
   * focused on `entityId`, and this read `targetEntityId`. No item was ever marked
   * attended — attention protection, rehearsal and every `attendedCount` the
   * consolidator weighs were a design that never ran. What the mind attended to
   * faded exactly as fast as what it ignored.
   */
  private _applyAttention( state: ReadonlySimulationState, tick: Tick ): void {
    for( const entity of state.entities.values() ){
      if( entity.type !== 'attention.focus') continue
      const targetId = entity.metadata?.entityId as string | undefined
      if( !targetId ) continue
      const item = this._items.find( i => i.sourceEntityId === targetId )
      if( item && !item.attendedAt.includes( tick ) ) item.attendedAt.push( tick )
    }

    // Trim attendedAt history to last 20 ticks to avoid unbounded growth
    for( const item of this._items ){
      if( item.attendedAt.length > 20 )
        item.attendedAt = item.attendedAt.slice( -20 )
    }
  }

  /**
   * Items that have been attended 3+ times receive a small activation boost
   * — simulating active rehearsal keeping them in working memory.
   */
  private _rehearseItems(): void {
    for( const item of this._items ){
      if( item.attendedAt.length >= 3 )
        item.activation = Math.min( 1, item.activation + 0.02 )
    }
  }

  /**
   * Write each live WM item as a state entity so downstream engines can read them,
   * and delete any stale WM entities that no longer correspond to live items.
   */
  private _persistItems( tick: Tick, state: ReadonlySimulationState, commands: StateCommands ): void {
    const liveIds = new Set<string>()

    for( const item of this._items ){
      const entityId = `wm-item-${item.id}`
      liveIds.add( entityId )
      commands.set!.push({
        id: entityId,
        type: 'working_memory.item',
        metadata: {
          wmType: item.type,
          content: item.content,
          activation: item.activation,
          // The strength it went in with. An item is decayed in the same pass that
          // admits it, so the first activation anyone reads is already a tick's
          // decay down — how much depends on the tick's length — and consolidation
          // weighed THAT: a percept was remembered by 0.018 at 1 tick/s and never
          // at 2 s (EpisodicConsolidator._findCandidates).
          encoding: item.encoding ?? item.activation,
          attendedCount: item.attendedAt.length,
          tags: item.tags,
          tick
        }
      })
    }

    // Remove stale WM entities from state that are no longer in the live item set
    // (entities written in a previous tick whose item has since decayed)
    for( const entity of state.entities.values() ){
      if( entity.type === 'working_memory.item' && !liveIds.has( entity.id ) ){
        commands.delete!.push( entity.id )
      }
    }
  }

  private _evictIfNeeded(): void {
    if( this._items.length < this._modulatedCapacity ) return
    this._items.splice( this._weakestIndex(), 1 )
  }

  /** The item that loses a slot first: least active, then least salient, then earliest. */
  private _weakestIndex(): number {
    let minIdx = 0
    for( let i = 1; i < this._items.length; i++ )
      if( weaker( this._items[i]!, this._items[minIdx]! ) ) minIdx = i
    return minIdx
  }
}

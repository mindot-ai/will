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
 *   - Recency effect (newest items displace oldest when at capacity)
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
}

export class WorkingMemory implements SimulationEngine, CognitiveEngine {
  readonly name     = 'working-memory'
  
  private _maxChunks:           number
  private _baseDecayRate:       number
  private _attentionProtection: number
  private _retrievalThreshold:  number
  private _emitEvents:          boolean

  private _items: WMItem[] = []
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
    this._items.push({ ...item, id, createdAt })
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
   */
  private _ingestPercepts( state: ReadonlySimulationState, tick: Tick ): void {
    for( const entity of state.entities.values() ){
      if( entity.type !== 'percept') continue
      if( this._items.some( i => i.sourceEntityId === entity.id ) ) continue

      const summary = ( entity.metadata?.summary ?? entity.metadata?.content ?? '') as string
      if( !summary || summary.startsWith('New percept:') ) continue

      this._evictIfNeeded()
      this._items.push({
        id: `wm-percept-${entity.id}`,
        type: 'percept',
        content: { summary, entityId: entity.id },
        activation: 0.75,
        attendedAt: [],
        createdAt: tick,
        sourceEntityId: entity.id,
        tags: [ 'percept', ...(( entity.metadata?.tags as string[] ) ?? []) ],
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
   */
  private _applyAttention( state: ReadonlySimulationState, tick: Tick ): void {
    for( const entity of state.entities.values() ){
      if( entity.type !== 'attention.focus') continue
      const targetId = entity.metadata?.targetEntityId as string | undefined
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
    let minIdx = 0
    for( let i = 1; i < this._items.length; i++ ){
      const cur = this._items[i]
      const best = this._items[minIdx]
      if( cur !== undefined && best !== undefined && cur.activation < best.activation ) minIdx = i
    }
    this._items.splice( minIdx, 1 )
  }
}

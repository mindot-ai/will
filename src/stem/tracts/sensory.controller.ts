// ─────────────────────────────────────────────────────────────
// src/stem/tracts/sensory.controller.ts  —  per-Will senses I/O subsystem
// ─────────────────────────────────────────────────────────────
//
// SensoryController owns the senses input + LLM chunk-streaming output
// boundary extracted from WillStem (R5-e):
//   - input ingestion: senseText / senseSignal / injectEvent
//   - real-time chunk streaming: addChunkListener / addSensoryChunkListener
//     and their sync helpers (syncChunkBroadcaster + the addChunkCallback fan-out)
//
// WillStem delegates the matching public methods here, so the god-object no
// longer owns this concern. The ops touch only WillInstance fields (no Will
// id needed), so these methods take the resolved instance directly; WillStem
// still validates existence via _get(id) before delegating.
//
// Behaviour is preserved verbatim from the original WillStem methods;
// this is a pure extract-collaborator refactor.
// ─────────────────────────────────────────────────────────────

import type { TextMessage, SensoryInput } from '#senses/index'
import type { WillInstance } from '#stem/index'

export class SensoryController {
  /** Instances whose SSE chunk fan-out has already been registered on the engine. */
  private readonly _chunkWired = new WeakSet<WillInstance>()
  /** Per-Will monotonic counter for deterministic injected-event ids (replay). */
  private readonly _eventSeq   = new WeakMap<WillInstance, number>()

  // ── Input ingestion ──────────────────────────────────────────

  /**
   * Route an external text message through the Will's AuditionEngine.
   * The senses-aware AuditionEngine handles salience, thread digests,
   * LanguagePercept publication, conversation-facet spawn/reuse, and LLM
   * reply generation. Reply delivery is async via the outbox / SSE channel.
   */
  async senseText( instance: WillInstance, input: TextMessage ): Promise<void> {
    await instance.cognition.auditionEngine.sense( input )
  }

  /**
   * Route a raw SensoryInput to the appropriate sense engine by domain.
   * Used by the debug `POST /senses/:domain/ingest` route.
   */
  async senseSignal( instance: WillInstance, domain: string, input: SensoryInput ): Promise<void> {
    const cog = instance.cognition
    const engineMap: Record<string, { sense: (i: SensoryInput) => Promise<void> }> = {
      audition:        cog.auditionEngine,
      vision:          cog.visionEngine,
      somatosensation: cog.somatosensationEngine,
      olfaction:       cog.olfactionEngine,
      gustation:       cog.gustationEngine,
    }
    const engine = engineMap[ domain ]
    if( !engine ) throw Object.assign( new Error(`Unknown sense domain: ${domain}`), { code: 400 } )
    await engine.sense( input )
  }

  /**
   * Inject a percept or external event into the Will's world.
   * The event is picked up by perceptual engines on the next tick.
   */
  injectEvent( instance: WillInstance, event: { type: string; payload: Record<string, unknown> } ): void {
    // Deterministic id (tick + per-Will monotonic counter) so injected-event
    // entities reproduce on replay — they're compared in ReplayComparison, and
    // Date.now()+random made them diverge every run. createdAt/updatedAt are left
    // to StateManager.setEntity, which stamps the (deterministic) sim clock time.
    const seq = ( this._eventSeq.get( instance ) ?? 0 ) + 1
    this._eventSeq.set( instance, seq )

    instance.simulation.stateManager.setEntity({
      id:       `external-event-${instance.tickCount}-${seq}`,
      type:     event.type,
      metadata: event.payload,
    })
  }

  // ── Real-time LLM chunk streaming (F3) ───────────────────────

  /**
   * Subscribe to real-time LLM token chunks for this Will (Will-wide).
   * The callback fires for each text token during executive LLM generation.
   * Returns an unsubscribe function — call it when the SSE connection closes.
   */
  addChunkListener( instance: WillInstance, fn: ( chunk: string ) => void ): () => void {
    instance.chunkListeners.add( fn )
    this.syncChunkBroadcaster( instance )

    return () => {
      instance.chunkListeners.delete( fn )
      this.syncChunkBroadcaster( instance )
    }
  }

  /**
   * Subscribe to real-time LLM token chunks for a specific conversation entity.
   *
   * Unlike addChunkListener() (Will-wide), this fires only when the AuditionEngine
   * conversation facet for `entityId` is actively streaming — isolating chunks to the
   * relevant SSE/WS client connection.
   *
   * On the first listener for any entity, wires addChunkCallback() on the
   * AuditionEngine to fan out chunks by entityId. Subsequent listeners reuse the same
   * callback — no duplicate registration occurs.
   *
   * Returns an unsubscribe function — call it when the SSE/WS connection closes.
   */
  addSensoryChunkListener(
    instance: WillInstance,
    entityId: string,
    fn: ( chunk: string ) => void,
  ): () => void {
    let listeners = instance.sensoryChunkListeners.get( entityId )
    if( !listeners ){
      listeners = new Set()
      instance.sensoryChunkListeners.set( entityId, listeners )
    }

    listeners.add( fn )

    // Register the SSE fan-out on the engine once per instance. It reads the live
    // sensoryChunkListeners map, so it stays correct as listeners come and go, and
    // coexists with other chunk subscribers (e.g. the transport emit) — the engine
    // chunk callback is multi-subscriber.
    this._ensureChunkFanout( instance )

    return () => {
      listeners!.delete( fn )
      if( listeners!.size === 0 )
        instance.sensoryChunkListeners.delete( entityId )
    }
  }

  /** Register the per-instance SSE chunk fan-out on the AuditionEngine (idempotent). */
  private _ensureChunkFanout( instance: WillInstance ): void {
    if( this._chunkWired.has( instance ) ) return
    const audition = instance.cognition.auditionEngine
    if( typeof ( audition as { addChunkCallback?: unknown } ).addChunkCallback !== 'function') return

    this._chunkWired.add( instance )
    audition.addChunkCallback( ( entityId: string, _threadId: string, chunk: string ) => {
      const fns = instance.sensoryChunkListeners.get( entityId )
      if( !fns ) return
      for( const fn of fns ){
        try { fn( chunk ) } catch {}
      }
    })
  }

  syncChunkBroadcaster( instance: WillInstance ): void {
    // Get the executive engine (typed loosely to avoid circular imports)
    const exec = ( instance.cognition as unknown as Record<string, unknown> )?.executiveEngine as
      { setChunkBroadcaster?: ( fn: (( c: string ) => void) | null ) => void } | undefined
    if( !exec?.setChunkBroadcaster ) return

    if( instance.chunkListeners.size === 0 ){
      exec.setChunkBroadcaster( null )
    }
    else {
      // Single broadcaster that fans out to all listeners
      exec.setChunkBroadcaster(( chunk: string ) => {
        for( const fn of instance.chunkListeners ){
          try { fn( chunk ) } catch {}
        }
      })
    }
  }
}

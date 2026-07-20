// ─────────────────────────────────────────────────────────────
// src/agency/deliberation.engine.ts  —  the System-2 seam
// ─────────────────────────────────────────────────────────────
//
// The DeliberationEngine is the only place the LLM touches the agency pipeline,
// and it does so through the SAME unified-inference path as everything else: it
// spawns a facet — "a focused instance of the executive consciousness" — which
// builds its prompt from the unified PromptFactory (persona, identity, live
// self-context). There is NO bespoke prompt here. This is the project-wide rule:
// every LLM call shares one self, so the Will never fractures / hallucinates a
// different identity when it deliberates vs. converses vs. narrates.
//
// It is recruited only when the selector marks a choice 'deliberating' (ambiguous
// or high-stakes). It then biases the competition — choosing among the candidate
// affordances the substrate already surfaced (ideomotor: imagining outcomes
// pre-activates one) — and writes the result back as the now-'selected' intent.
// It never invents actions outside the field. Message *content* authoring stays
// with the unified conversation facet path (AuditionEngine), not duplicated here.
//
// With no executive attached (basic tier) or the facet budget full, it confirms
// the substrate's provisional winner — graceful System-1 degradation, never a
// stall, and never an un-grounded LLM call.
// ─────────────────────────────────────────────────────────────

import { logger } from '#core/logger'
import type {
  Duration, Tick, SimulationContext,
  ReadonlySimulationState, StateCommands, EntityInput,
} from '#core/types'
import type { CognitiveBus } from '#cognition/bus'
import type { CognitiveEngine, EngineResult } from '#cognition/types'
import type { CognitiveEventSchema } from '#cognition/schema.registry'
import { revokedIntentIds, revocationId } from '#agency/revocation'

// ── Minimal structural view of the executive's facet machinery ───────────────
// Kept structural (not an import of the executive engine) so the agency module
// stays decoupled; ExecutiveEngine is assignable to DeliberationFacetProvider.

interface DeliberationFacetHandle {
  setFocus( focus: { title: string; content: string; instructions?: string; function?: string } ): void
  report( report: { type: string; payload: unknown } ): Promise<void> | void
  subscribe( listener: ( decision: { decision: unknown } ) => void ): () => void
  destroy(): void
}
export interface DeliberationFacetProvider {
  spawnFacet( role?: 'deliberation'): { attention: 'available' | 'full'; handle?: DeliberationFacetHandle }
}

interface Candidate {
  schema:          string
  targetEntityId?: string
  parameters?:     Record<string, unknown>
  activation?:     number
  /** The ability's declared meaning (external effectors) — what it is for. */
  description?:    string
  /** Channel B: this candidate is an active plan's current frontier step. */
  fromPlan?:       boolean
}

const DELIBERATION_INSTRUCTIONS =
  'Automatic action-selection was uncertain or the stakes were high. From the candidate actions ' +
  'listed above, choose the ONE that best fits who I am and my situation. Do not invent ' +
  'actions that are not listed. Put my chosen action as my single action; its "type" must be ' +
  'exactly one of the candidate names.'

export class DeliberationEngine implements CognitiveEngine {
  readonly name = 'deliberation'

  private _provider: DeliberationFacetProvider | null = null
  private _handle:   DeliberationFacetHandle | null = null
  private _bus:      CognitiveBus | null = null
  private _willName  = 'the mind'
  private _deliberations = 0

  attachBus( bus: CognitiveBus ): void { this._bus = bus }
  /**
   * Attach the executive (facet provider). Absent ⇒ the engine confirms the
   * substrate's winner (System 1) — used at basic tier where no LLM runs.
   */
  attachExecutive( provider: DeliberationFacetProvider ): void { this._provider = provider }
  setWillName( name: string ): void { this._willName = name }

  publishes(): CognitiveEventSchema[] {
    return [ { type: 'agency.deliberated', version: 1, validate: () => null } ]
  }
  subscribes(): string[] { return [] }
  onCognitiveEvent(): void { /* pull model — reads deliberating intents from frozen state */ }
  snapshot(): Record<string, unknown> { return { deliberations: this._deliberations } }

  async react(
    _delta:   Duration,
    tick:     Tick,
    state:    ReadonlySimulationState,
    _context: SimulationContext,
  ): Promise<EngineResult> {
    // Honor commitment revocations first (EXAFFERENCE P4): a `deliberating`
    // intent under a live tombstone is dropped — the world ruptured hard enough
    // to let go of it — and the tombstone with it. We never deliberate a
    // revoked intent.
    const revoked = revokedIntentIds( state.entities, tick )
    const del: string[] = []

    // One deliberation per tick (the serial bottleneck).
    let target: { id: string; meta: Record<string, unknown> } | null = null
    for( const [ id, e ] of state.entities ){
      if( e.type !== 'agency.intent') continue
      if( str( e.metadata?.['status'] ) !== 'deliberating') continue
      if( revoked.has( id ) ){ del.push( id, revocationId( id ) ); continue }   // revoked → drop
      const meta = ( e.metadata ?? {} ) as Record<string, unknown>
      if( !target || id < target.id ) target = { id, meta }   // stable pick
    }
    if( !target ) return del.length > 0 ? { commands: { delete: del } } : { commands: {} }

    const { id, meta }   = target
    const provisional    = str( meta['schema'] ) ?? 'wait'
    const candidates: Candidate[] = Array.isArray( meta['candidates'] ) ? ( meta['candidates'] as Candidate[] ) : []

    // No executive → confirm the substrate's winner (graceful System-1).
    if( !this._provider )
      return { commands: { set: [ this._commit( id, meta, provisional, candidates, 'no-executive') ],
        ...( del.length > 0 ? { delete: del } : {} ) } }

    // Deliberate through a UNIFIED facet (same persona/context as the master).
    const chosen = await this._deliberate( state, candidates, provisional, meta )

    this._deliberations++
    if( this._bus ){
      try {
        this._bus.publish({
          type: 'agency.deliberated', version: 1, sourceEngine: this.name,
          salience: 0.6, payload: { intentId: id, chosen, tick },
        })
      }
      catch { /* unregistered schema is telemetry-only */ }
    }

    return {
      commands: {
        set:     [ this._commit( id, meta, chosen, candidates, 'facet') ],
        ...( del.length > 0 ? { delete: del } : {} ),
        metrics: [ [ 'agency.deliberation.count', 1 ] ],
      },
    }
  }

  // ── internals ─────────────────────────────────────────────────

  /** Run one unified-inference deliberation. Returns the chosen schema (or the provisional winner on any failure). */
  private async _deliberate(
    state:       ReadonlySimulationState,
    candidates:  Candidate[],
    provisional: string,
    meta:        Record<string, unknown>,
  ): Promise<string> {
    try {
      if( !this._handle ){
        const spawned = this._provider!.spawnFacet('deliberation')
        if( spawned.attention === 'full' || !spawned.handle ){
          logger.info('[deliberation] facet budget full — confirming substrate winner')
          return provisional
        }
        this._handle = spawned.handle
      }

      let capturedDecision: unknown = undefined
      const unsub = this._handle.subscribe( d => { capturedDecision = d.decision } )

      this._handle.setFocus({
        title:        'Deliberation',
        function:     'deliberation',
        content:      this._buildFocusContent( state, candidates, meta ),
        instructions: DELIBERATION_INSTRUCTIONS,
      })
      await this._handle.report({ type: 'deliberation', payload: { candidateSchemas: candidates.map( c => c.schema ) } })
      unsub()

      const picked = extractChosen( capturedDecision, candidates )
      return picked ?? provisional
    }
    catch( err ){
      // Director/state not ready (e.g. executive hasn't run yet) or LLM failure →
      // fall back to the substrate winner. Drop a possibly-dead handle.
      this._handle = null
      logger.warn(`[deliberation] facet unavailable, confirming winner: ${ err instanceof Error ? err.message : String( err ) }`)
      return provisional
    }
  }

  /** Write the deliberating intent back as 'selected' with the chosen action. */
  private _commit(
    id:         string,
    meta:       Record<string, unknown>,
    chosen:     string,
    candidates: Candidate[],
    via:        string,
  ): EntityInput {
    const cand = candidates.find( c => c.schema === chosen )
    return {
      id, type: 'agency.intent',
      metadata: {
        ...meta,
        schema:         chosen,
        targetEntityId: cand?.targetEntityId ?? meta['targetEntityId'],
        parameters:     { ...( ( meta['parameters'] as Record<string, unknown> ) ?? {} ), ...( cand?.parameters ?? {} ) },
        status:         'selected',
        deliberated:    true,
        deliberatedVia: via,
      },
    }
  }

  /** The deliberation focus body — the candidate actions the substrate surfaced. */
  private _buildFocusContent(
    state:      ReadonlySimulationState,
    candidates: Candidate[],
    meta:       Record<string, unknown>,
  ): string {
    const lines: string[] = []
    // Channel B: if this choice arose by interrupting a pending action, name it so the
    // facet owns the interruption in-character rather than reasoning in a vacuum.
    const preemptedFrom = str( meta['preemptedFrom'] )
    if( preemptedFrom )
      lines.push(`I just broke off a pending action ("${ preemptedFrom }") because something more pressing pulled at me. Decide what to do now:`)
    else
      lines.push('My automatic action-selection was uncertain. Candidate actions:')
    candidates.forEach( ( c, i ) => {
      const to   = c.targetEntityId ? ` toward ${ c.targetEntityId }` : ''
      // The ability's meaning, so the facet weighs what each option IS FOR rather
      // than choosing among bare labels ("give" vs "attack" is a real difference).
      const what = c.description ? ` — ${ c.description }` : ''
      // Channel B: name the plan link so the facet chooses as the self pursuing it,
      // not blindly among labels ("this one is the next step of the plan I'm on").
      const plan = c.fromPlan ? " (my current plan's next step)" : ''
      lines.push(`${ i + 1 }. ${ c.schema }${ to }${ what }${ plan }`)
    })
    return lines.join('\n')
  }
}

// ─── decoding ────────────────────────────────────────────────────────────────

/** Pull the chosen schema from a facet decision, validated against the candidates. */
function extractChosen( decision: unknown, candidates: Candidate[] ): string | undefined {
  if( !decision || typeof decision !== 'object') return undefined
  const actions = ( decision as Record<string, unknown> )['actions']
  if( !Array.isArray( actions ) ) return undefined
  const valid = new Set( candidates.map( c => c.schema ) )
  for( const a of actions ){
    const type = ( a as Record<string, unknown> )?.['type']
    if( typeof type === 'string' && valid.has( type ) ) return type
  }
  return undefined
}

function str( v: unknown ): string | undefined {
  return typeof v === 'string' ? v : undefined
}

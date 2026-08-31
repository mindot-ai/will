// ─────────────────────────────────────────────────────────────
// src/stem/tracts/effector/escalation.lifecycle.ts
// ─────────────────────────────────────────────────────────────
//
// SIGNAL_BOUNDARY P1a — the escalation seam, extracted verbatim from
// `effector.controller.ts`. Hold, resolve, expire.
//
// An escalation is a Will asking before acting (POLICY_REAFFERENCE P4). The
// intent is held so the executor stops timing it out, the ask is voiced ONCE,
// and a host answer later approves (dispatch the withheld payload) or denies
// (refuse it). Unanswered, it degrades to a light refusal at the TTL.
//
// `_voiceEscalation` is here for now and does not belong here — see the note on
// the method. Moving it is P1a's third bullet, not this cut.

import { logger } from '#core/logger'
// The record type, not a string literal: `## What I've Said Lately` is built by
// reading it, and a second spelling here would be a contract kept in two places.
import { SENT_TYPE } from '#agency/conversation.aim'
import type { WillInstance } from '#stem/index'
import {
  ESCALATION_TTL_TICKS,
  type EffectorOps, type Escalation, type PendingResolution,
} from './types'

/** What the lifecycle needs from the seams either side of it. */
export interface EscalationDeps extends EffectorOps {
  /** Queue a refusal on the policy side — a denial or an expiry. */
  queueRefusal(
    instance: WillInstance, intentId: string, schema: string,
    reasonCode: string, finality: 'class' | 'parameter' | 'context',
  ): void
}

export class EscalationLifecycle {
  /** Escalations awaiting their first application (mark intent + voice the ask). */
  private _newEscalations   = new Map<string, Escalation[]>()
  /** Escalations currently held, keyed by intent id — the resolvable set. */
  private _activeEscalations = new Map<string, Map<string, Escalation>>()
  /** Host answers awaiting application at the next tick boundary. */
  private _pendingResolutions = new Map<string, PendingResolution[]>()

  constructor( private readonly _deps: EscalationDeps ){}

  /** Raise a new escalation, applied (marked + voiced) at the next boundary.
   *  Called by policy enforcement when a verdict says 'escalate'. */
  raise( instance: WillInstance, esc: Escalation ): void {
    const escalations = this._newEscalations.get( instance.config.id ) ?? []
    escalations.push( esc )
    this._newEscalations.set( instance.config.id, escalations )
  }

  /**
   * Record a host's answer to an escalation (POLICY_REAFFERENCE P4). Applied at
   * the next tick boundary so every simulation-state write stays on the boundary:
   * approve dispatches the held invocation to the world; deny refuses it. A
   * no-op if the intent id is not (or no longer) an active escalation.
   */
  resolve( instance: WillInstance, intentId: string, approved: boolean ): void {
    const queue = this._pendingResolutions.get( instance.config.id ) ?? []
    queue.push({ intentId, approved })
    this._pendingResolutions.set( instance.config.id, queue )
  }

  /** Apply host answers to active escalations (POLICY_REAFFERENCE P4). */
  applyResolutions( instance: WillInstance ): void {
    const queue = this._pendingResolutions.get( instance.config.id )
    if( !queue || queue.length === 0 ) return
    this._pendingResolutions.set( instance.config.id, [] )

    const active = this._activeEscalations.get( instance.config.id )
    for( const { intentId, approved } of queue ){
      const esc = active?.get( intentId )
      if( !esc ) continue                        // unknown / already resolved — ignore
      active!.delete( intentId )
      this._clearEscalated( instance, intentId ) // release the executor's hold
      if( approved ){
        this._deps.buffer( instance, esc.payload )  // dispatch the held invocation now
        logger.info(`[policy] escalation APPROVED → dispatching "${esc.schema}" intent "${intentId}"`)
      }
      else {
        this._deps.queueRefusal( instance, esc.intentId, esc.schema, esc.reasonCode, 'class')
        logger.info(`[policy] escalation DENIED → refusing "${esc.schema}" intent "${intentId}"`)
      }
    }
  }

  /**
   * Degrade escalations no one answered in time into light refusals (P4).
   *
   * Finality 'parameter' is chosen for its BEHAVIOUR, not its name: silence is
   * not literally an argument problem, but the light-dent-with-recovery it
   * produces is exactly right — a Will whose asks go unanswered should ask
   * progressively less, and should resume asking if someone starts answering.
   * 'class' would be a lie (nobody said never) and 'context' would teach
   * nothing, leaving the mind to escalate forever into an empty room.
   */
  expire( instance: WillInstance, tick: number ): void {
    const active = this._activeEscalations.get( instance.config.id )
    if( !active || active.size === 0 ) return
    for( const [ intentId, esc ] of active ){
      if( tick < esc.expiresAt ) continue
      active.delete( intentId )
      this._clearEscalated( instance, intentId )
      this._deps.queueRefusal( instance, esc.intentId, esc.schema, 'ESCALATION_EXPIRED', 'parameter')
      logger.info(`[policy] escalation EXPIRED → refusing "${esc.schema}" intent "${intentId}"`)
    }
  }

  /** Raise each newly-escalated intent (POLICY_REAFFERENCE P4): mark it held in
   *  simulation state, voice the ask ONCE, and move it to the resolvable set. */
  applyNew( instance: WillInstance, tick: number ): void {
    const pending = this._newEscalations.get( instance.config.id )
    if( !pending || pending.length === 0 ) return
    this._newEscalations.set( instance.config.id, [] )

    const active = this._activeEscalations.get( instance.config.id ) ?? new Map<string, Escalation>()
    for( const esc of pending ){
      esc.expiresAt = tick + ESCALATION_TTL_TICKS
      this._markEscalated( instance, esc.intentId, esc.expiresAt )
      this._voiceEscalation( instance, esc )
      active.set( esc.intentId, esc )
    }
    this._activeEscalations.set( instance.config.id, active )
  }

  /** Mark the awaiting intent held: the executor stops timing it out (P4). */
  private _markEscalated( instance: WillInstance, intentId: string, expiresAt: number ): void {
    const intent = instance.simulation.stateManager.snapshot().entities.get( intentId )
    if( !intent || intent.type !== 'agency.intent') return
    instance.simulation.stateManager.setEntity({
      id:       intent.id,
      type:     intent.type,
      metadata: { ...( intent.metadata ?? {} ), escalated: true, escalationExpiresAt: expiresAt },
    })
  }

  /** Release the hold so the executor resumes normal timeout for this intent. */
  private _clearEscalated( instance: WillInstance, intentId: string ): void {
    const intent = instance.simulation.stateManager.snapshot().entities.get( intentId )
    if( !intent || intent.type !== 'agency.intent') return
    const meta = { ...( intent.metadata ?? {} ) } as Record<string, unknown>
    delete meta['escalated']; delete meta['escalationExpiresAt']
    instance.simulation.stateManager.setEntity({ id: intent.id, type: intent.type, metadata: meta })
  }

  /**
   * Voice the escalation as a first-person broadcast ask — once, at raise time.
   *
   * THIS DOES NOT BELONG HERE, and the P1a note says so: speech is the outbox's
   * job, and an escalation should *ask for* an utterance rather than compose
   * one. `escalationAsk` below is a string template standing in for a facet
   * that would say it in the Will's own voice. Left in place by this cut, which
   * is a pure move — relocating it is a behaviour question about who authors
   * the words, not a question about where the file boundary goes.
   */
  private _voiceEscalation( instance: WillInstance, esc: Escalation ): void {
    // The SIMULATION clock, not the lifecycle's `tick`.
    //
    // Two counters live here and they are thousands apart. `applyPolicyOutcomes`
    // passes `instance.tickCount` — a process-local counter that starts at 0 on
    // every boot — and the whole escalation lifecycle is self-consistent in that
    // space, so nothing else notices. `conversation.sent` is read in SIM-clock
    // space by `readSpokenTurns` and `spokenAtByEntity`, where the state manager
    // stamps `updatedAtTick` from the simulation clock.
    //
    // Written with the process counter, the ask landed ~17,000 ticks in the past
    // on a live Will: it still existed, but `readSpokenTurns` sorts oldest-first
    // and `## What I've Said Lately` keeps only the newest few — so the record
    // was dropped from the one section it was added to appear in. Found by a live
    // run, not by the suite: both halves were internally consistent.
    const tick = instance.simulation.clock.currentTick
    const content = escalationAsk( esc.schema, esc.reasonCode )
    try {
      instance.cognition.outboxWriter.enqueue({
        targetEntityId: '*',
        content,
        effectorName:    'broadcast',
      })
    }
    catch( err ){
      logger.warn(`[policy] escalation voice failed for "${esc.schema}": ${errMsg( err )}`)
      return
    }

    // Words that left the mind have to exist in its record of having said them.
    //
    // These did not. The ask goes out through the outbox directly — no intent,
    // no `_deliver` — so nothing wrote the `conversation.sent` that
    // `## What I've Said Lately` is built from, and the one thing she could not
    // see was the one thing she was being asked about. Live: she broadcast
    // "I want to discord_unban_member … May I go ahead?", was asked who she
    // meant, and answered "I didn't send that. I've never asked to unban
    // anyone" — seven times across four minutes, correctly, because from the
    // inside she never had.
    //
    // Recorded AFTER the enqueue and skipped when it throws: a record of speech
    // that never left is the same fault facing the other way.
    try {
      instance.simulation.stateManager.setEntity({
        // Keyed by schema as well as tick — two intents can escalate on one
        // tick, and a shared id would leave the mind remembering one ask.
        id:   `conv-sent-escalation-${ esc.schema }-${ tick }`,
        type: SENT_TYPE,
        metadata: {
          targetEntityId:   '*',
          // She said it to the room. Naming it the way she would say it keeps
          // the line readable next to the people in the same list.
          targetEntityName: 'everyone here',
          messageCount:     1,
          preview:          content.slice( 0, 100 ),
          effectorName:     'broadcast',
          tick,
          delivered:        false,
        },
      })
    }
    catch( err ){ logger.warn(`[policy] escalation record failed for "${esc.schema}": ${errMsg( err )}`) }
  }
}

/** First-person ask for an escalated action, carrying the reason's MEANING (P4).
 *  Kept template-simple here; the facet-authored version is a later refinement. */
function escalationAsk( schema: string, reasonCode: string ): string {
  const meaning = ESCALATION_MEANINGS[ reasonCode ] ?? 'I need your approval before I can do this'
  return `I want to ${ schema }, but ${ meaning }. May I go ahead?`
}

/** reasonCode → human meaning. Unknown codes fall back to a generic phrase. */
const ESCALATION_MEANINGS: Record<string, string> = {
  APPROVAL_REQUIRED: 'I need your approval before I can on my own',
  WRITE_REQUIRES_APPROVAL: "it writes to the world and I shouldn't on my own",
  PAYMENT_REQUIRES_APPROVAL: 'it moves money and I must not do that unattended',
  DEPLOY_REQUIRES_APPROVAL: 'it ships something and needs a human to sign off',
}

function errMsg( err: unknown ): string {
  return err instanceof Error ? err.message : String( err )
}

// ─────────────────────────────────────────────────────────────
// src/cognition/faculties/executive.engine/escalation.buffer.ts
// ─────────────────────────────────────────────────────────────
//
// EscalationBuffer — facet→master handoffs awaiting a tick boundary (R5-g-2).
//
// A focused facet sometimes surfaces something only the singular seat can own:
// work to plan, or an intention toward someone it is not itself talking to. It
// publishes `executive.facet.handoff`; those events arrive between tick
// boundaries, while state is read-only, so they can't be written as percepts
// directly. This buffer holds them until the next onReasoningComplete(), where
// they are drained into high-salience percept entities (StateCommands.set) so
// Exteroception surfaces them as "## Percepts (What I Notice)" on the following
// master cycle.
//
// The master reads these as things IT noticed about its own situation — NEVER
// as incoming messages — and responds by creating plans/goals or by deciding
// whether it still means to make a contact. It never replies; the facet that
// raised the handoff owns the talking.
//
// ── Why the topic is not `audition.task.signal` ──────────────
//
// It used to be, and the payload was conversation-shaped: `{ entityId, threadId,
// … }`. That made the master's handoff channel the private property of ONE sense
// engine. A planning facet, a supervision facet, a deliberation facet — none of
// them had any way to hand anything to the master at all, and every facet type
// added afterwards would have had to mint its own topic and its own handler
// beside `_onAuditionTaskSignal`. The master does not need to know which faculty
// raised a handoff; it needs to know that a focused part of it formed something
// its singular seat must own. One topic, one handler, a discriminated `kind`.
// ─────────────────────────────────────────────────────────────

import type { EntityInput } from '#core/types'
import { perceptEntity } from '#cognition/percept.entity'

/**
 * Work the master should plan or re-goal. The facet has already said whatever
 * needed saying to the person in front of it; this is the cognitive remainder.
 */
export interface EscalationHandoff {
  kind:      'escalation'
  reasoning: string
}

/**
 * An intention toward a THIRD party — "I'll reach out to FKEM now" — formed
 * while attending to something else. The facet never opens that channel itself,
 * so this is the only thing standing between having decided to make contact and
 * having made it.
 */
export interface UndertakingHandoff {
  kind:      'undertaking'
  target:    string
  gist?:     string
  reasoning: string
}

/** Everything a facet can hand up. Add a variant here, not a new topic. */
export type HandoffBody = EscalationHandoff | UndertakingHandoff

/**
 * Schema validator for `executive.facet.handoff` — every facet type publishes
 * through it, so the shape is checked at the bus rather than trusted per-caller.
 * Returns null when valid, else the reason.
 */
export function validateFacetHandoff( payload: unknown ): string | null {
  if( !payload || typeof payload !== 'object') return 'payload must be object'
  const body = ( payload as { body?: unknown } ).body
  if( !body || typeof body !== 'object') return 'payload.body is required'
  const kind = ( body as { kind?: unknown } ).kind
  if( kind === 'escalation') return null
  if( kind === 'undertaking')
    return typeof ( body as { target?: unknown } ).target === 'string'
        && ( body as { target: string } ).target.trim().length > 0
      ? null
      : 'undertaking handoff requires a non-empty target'
  return `unknown handoff kind: ${String( kind )}`
}

export interface PendingHandoff {
  /** Which facet raised it — for tracing a percept back to the thread that made it. */
  facetId?: string
  /**
   * Who the facet was attending to, when it was attending to a someone. Absent
   * for facets whose focus has no person in it (planning, deliberation) — which
   * is exactly the case the old conversation-shaped payload could not express.
   */
  subjectEntityId?: string
  subjectName?:     string
  threadId?:        string
  /** Sim tick at which the facet formed this. Undertaking discharge keys on it. */
  tick:             number
  body:             HandoffBody
}

/** Requester context captured from the first buffered handoff, used to tag new goals. */
export interface EscalationRequester {
  entityId: string
  threadId: string
}

export interface DrainedEscalations {
  /** High-salience percept entities to merge into StateCommands.set. */
  percepts: EntityInput[]
  /** First handoff's requester context, or undefined when none carried one. */
  requester?: EscalationRequester
}

/** "in my conversation with X" when there was one, "while I was working" otherwise. */
function whereItHappened( h: PendingHandoff ): string {
  const who = h.subjectName ?? h.subjectEntityId
  return who ? `In my conversation with ${who}` : 'While I was working on something else'
}

export class EscalationBuffer {
  private _pending: PendingHandoff[] = []

  /** Buffer one handoff for injection on the next master cycle. */
  push( handoff: PendingHandoff ): void {
    this._pending.push( handoff )
  }

  get size(): number    { return this._pending.length }
  get isEmpty(): boolean { return this._pending.length === 0 }

  /**
   * Convert every buffered handoff into a high-salience percept entity and clear
   * the buffer. Returns the percepts plus the first handoff's requester context
   * (used to tag goals the master creates in response).
   *
   * WHY THESE DO NOT GO THROUGH A SENSE DOOR (SIGNAL_BOUNDARY P4).
   *
   * P4's rule is that only a sense or exteroception writes a percept, and these
   * two are the standing exception. A sense door carries AFFERENCE: a signal
   * crossing into the mind, either from the world (exafferent) or from the
   * mind's own act returning THROUGH the world (reafferent). A facet handing off
   * to the master crosses neither boundary — it never left the mind. Routing it
   * through a sense would dress one part of a mind up as news from outside,
   * which is precisely the laundering P1 removed from `inspect`, and §6 of the
   * epoch names that class of over-unification as the thing not to do.
   *
   * They still had to stop being hand-rolled literals, and they have: everything
   * goes through `perceptEntity()`, so the shape is the one shape.
   *
   * What is left open, and worth deciding rather than inheriting: a handoff is
   * using the percept entity as a DELIVERY MECHANISM, because the percept block
   * is what the executive prompt renders. A `self.handoff` type with its own
   * section would say what this actually is. That is a prompt change and a
   * `_reconcileUndertakings` change, so it is a decision, not a cleanup.
   */
  drainToPercepts(): DrainedEscalations {
    const percepts: EntityInput[] = []
    let seq = 0
    for( const h of this._pending ){
      // Distinct ids per drain: two handoffs from one thread on one tick are two
      // separate things the mind noticed, and keying on (subject, tick) alone would
      // silently collapse them into whichever came last.
      const id = `escalation-percept-${h.subjectEntityId ?? h.facetId ?? 'self'}-${h.tick}-${seq++}`

      // FACTS the builder owns, and the writer's OWN fields beside them. Split
      // this way because `perceptEntity()` spreads `extra` first: a writer can
      // add whatever it likes and still cannot clobber `tick` or `provenance`.
      const core = {
        id,
        tick:     h.tick,
        salience: 0.85,
        // REAFFERENT. Nothing outside the mind produced this: a facet of it
        // raised the handoff, and the master is now noticing its own part's
        // doing. Tagging it costs no behaviour — the rupture gate excludes
        // reafferent and untagged alike — but it stops the exclusion being an
        // accident, and it is the honest answer rather than the convenient one.
        provenance: 'reafferent' as const,
        ...( h.subjectEntityId ? { entityId: h.subjectEntityId } : {} ),
      }
      const mine = {
        source: 'executive-facet',
        ...( h.threadId ? { threadId: h.threadId } : {} ),
        ...( h.facetId  ? { facetId:  h.facetId  } : {} ),
      }

      // Built through `perceptEntity()` like every other percept in the package
      // (SIGNAL_BOUNDARY P4). These were the last hand-rolled `type: 'percept'`
      // literals, and a hand-rolled one is exactly how `tick` went missing on
      // the wake and delivery percepts and made them immortal.
      //
      // They do NOT go through a sense door, and should not — see the note on
      // `drainToPercepts` above for why.
      percepts.push( h.body.kind === 'undertaking'
        ? perceptEntity( {
          ...core,
          category: 'undertaking',
          // First person: this is the mind noticing what IT said it would do, not
          // a report handed to it. What makes it act is that the words are still
          // unsent — an undertaking it has already honoured reads the same until
          // it checks, which is exactly the check we want it making.
          // Everything actionable goes in `summary`: that is the only field the
          // executive context actually renders (context.ts extractPercepts reads
          // summary/content and nothing else).
          //
          // The closing clause is the whole point. A mind that has SAID it will make
          // contact remembers deciding, and cannot tell from the inside whether the
          // words went out — so it follows up on a message it never sent. Naming the
          // gap is what lets it check. It stays a decision either way: it may have
          // changed its mind, or judge this the wrong moment, and a reach-out
          // competes with everything else like any other action.
          summary: `${whereItHappened( h )} I said I would reach ${h.body.target}`
            + ( h.body.gist ? ` — what I meant to say: "${h.body.gist.slice( 0, 220 )}"` : '')
            + `. Nothing has gone to them yet; saying it in that conversation did not send it.`
            + ` If I still mean it, I reach out with target '${h.body.target}'.`
            + ` If I no longer do, I let it go — but I do not leave it half-done while telling them it is handled.`,
        }, {
          ...mine,
          // Who was promised, and when the promise was made. The executive
          // reconciles against these (see _reconcileUndertakings): once the mind
          // has actually reached this target since `tick`, the percept is retired
          // rather than left standing as a claim the words are still unsent.
          undertakingTarget: h.body.target,
        } )
        : perceptEntity( {
          ...core,
          category: 'task-escalation',
          // The steer lives IN the summary because that is the only field the
          // executive context renders (context.ts extractPercepts reads
          // summary/content and nothing else). It sat in a sibling `directive`
          // field for its whole life and never once reached the master.
          summary: `[Task from ${h.subjectName ?? h.subjectEntityId ?? 'my own focused work'}] ${h.body.reasoning}`
            + ' — this is mine to plan or re-goal; the part of me that raised it handles the talking.',
        }, mine ) )
    }

    // Capture requester context before clearing — used to tag new goals. Only a
    // handoff that came from a conversation has one.
    const first = this._pending.find( h => h.subjectEntityId )
    const requester: EscalationRequester | undefined =
      first ? { entityId: first.subjectEntityId!, threadId: first.threadId ?? '' } : undefined

    this._pending = []

    return { percepts, requester }
  }
}

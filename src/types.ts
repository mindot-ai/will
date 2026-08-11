import type { EngineRegistry } from '#cognition/index'
import type { ReadonlySimulationState, StateCommands } from '#core/types'
import type { OutboxWriter } from '#stem/tracts/outbox.writer'
import type { SchemaRepertoire } from '#agency/schemas/repertoire'
import type { AccessGrants } from '#agency/access.grants'

export interface Cognition extends EngineRegistry {
  /** Shared outbox producer (row shape + reply audit); see #stem/tracts/outbox.writer. */
  outboxWriter:          OutboxWriter
  /** Agency pipeline competence layer (learned schemas + skills) — see #agency. */
  schemaRepertoire:     SchemaRepertoire
  /** Permission / sense-gate authority (replaces effectorRegistry's grant role). */
  accessGrants:         AccessGrants
}

/**
 * Emitted when Will decides to use an effector that has no internal handler.
 * The host system receives this via SSE and is responsible for execution.
 * When done, the host calls injectEvent() with the result.
 */
export interface effectorInvocation {
  id:               string
  /** Correlation handle — the awaiting `agency.intent` id. Echo it when POSTing to
   *  `POST /v1/wills/:id/effectors/invoked/ack`; the Will reconciles the result onto
   *  that intent. (Field name kept for wire-contract stability; no longer a
   *  `decision.record` id since the agency cutover.) */
  decisionRecordId: string
  effectorName:      string
  parameters:       Record<string, unknown>
  targetEntityId:   string | undefined
  /**
   * The addresses the world knows `targetEntityId` by.
   *
   * `targetEntityId` is an ANCHOR (`ke:1sqlkux`) — since 0.9.0 identity is opaque
   * and deliberately not an address, because who someone is and where to find them
   * are different facts. A host holds channel ids and knows nothing of anchors, so
   * an invocation naming only the referent is one no surface can act on. Resolved
   * inside, where the alias table lives, exactly as the outbox resolves a message
   * addressed to a referent.
   *
   * Outbound only: this is the mind saying which of its own handles it means.
   * Nothing here lets a surface name someone TO the mind — that is what perception
   * is for.
   */
  targetAddresses?: readonly string[]
  reasoning:        string
  /** The ability's declared meaning (from its EffectorDeclaration), when present. */
  description?:     string
  tick:             number
  timestamp:        number
}

export interface WorldEntity {
  id: string
  type: string
  name: string
  description: string
  /** What effectors can be used on this entity */
  affordances: string[]  // Effector names
  /** Current state */
  state: Record<string, unknown>
  /** Is this entity currently reachable/interactable */
  reachable: boolean
}

export interface ActionRequest {
  /** The effector being invoked */
  effector: string
  /** Parameters for the effector */
  parameters: Record<string, unknown>
  /** Target entity (if any) */
  targetEntityId?: string
  /** The Will's reasoning for this action */
  reasoning: string
  /** Expected outcome description */
  expectedOutcome: string
  /** The tick when this was decided */
  decidedAt: number
}

export interface ActionResult {
  /** Whether the action succeeded */
  success: boolean
  /** Human-readable description of what happened */
  description: string
  /** State changes that occurred as a result */
  commands: StateCommands
  /** New entities created by this action */
  createdEntities?: WorldEntity[]
  /** Feedback for the Will to learn from */
  feedback: {
    outcomeQuality: number  // 0-1: how good was the outcome
    surprise: number        // 0-1: how unexpected was the outcome
    lessons: string[]       // What can be learned
  }
}

export interface WorldInterface {
  /** Get all entities the Will can perceive right now */
  getPerceptibleEntities( state: ReadonlySimulationState ): WorldEntity[]

  /** Get entities the Will can interact with */
  getInteractableEntities( state: ReadonlySimulationState ): WorldEntity[]

  /** Returns true if this world can handle the given effector name. */
  canHandle( effectorName: string ): boolean

  /** Execute a Will's action in the world */
  executeAction( request: ActionRequest, state: ReadonlySimulationState ): Promise<ActionResult>
}

export interface OutboxMessage {
  id:               string
  targetEntityId:   string
  targetEntityName?: string
  content:          string
  effectorName:      'talk' | 'text' | 'gesture' | 'broadcast'
  gestureType?:     string             // for gesture effector
  createdAtTick:    number
  createdAt:        number
  /** If this message is a reply, the incoming message ID it is replying to. */
  replyToMessageId?: string
  /**
   * Conversation thread this message belongs to.
   * Set by AuditionEngine/OutboxWriter.enqueueReply() — ties all bubbles from one exchange
   * to the same thread so the SSE consumer can group them into a single reply_complete.
   */
  threadId?: string
  /** Delivery lifecycle: 'pending' until the SSE consumer confirms receipt. */
  deliveryStatus:   'pending' | 'delivered' | 'failed'
  /** Token usage from the outbound() composition call — used for exchange billing. */
  usage?:           { promptTokens: number; completionTokens: number }
}

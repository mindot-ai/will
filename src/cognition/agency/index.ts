// ─────────────────────────────────────────────────────────────
// src/engines/agency/index.ts  —  agency pipeline barrel
// ─────────────────────────────────────────────────────────────
//
// The mind-like action layer: perception synthesizes a field of affordances, a
// biased competition selects one (recruiting the LLM only when ambiguous or
// high-stakes), the executor enacts it (running learned composites for real),
// and reafference turns outcomes into competence that proceduralizes and travels
// in the PMA. See AGENCY_PIPELINE_TODO.md.

export * from '#agency/types'

export { INNATE_SCHEMAS, INNATE_SCHEMA_BY_ID } from '#agency/schemas/innate'
export { externalSchemas } from '#agency/schemas/external'
export { SchemaRepertoire } from '#agency/schemas/repertoire'
export type { OutcomeObservation } from '#agency/schemas/repertoire'

export { AffordanceSynthesizer } from '#agency/engines/affordance.synthesizer'

export { ActionSelector } from '#agency/engines/action.selector'
export {
  DeliberationEngine,
  type DeliberationFacetProvider
} from '#agency/engines/deliberation.engine'
export {
  scoreAffordance,
  competitionEntropy,
  stakes,
  goalRelevance,
  driveUrgency,
  novelty,
  risk,
  DEFAULT_WEIGHTS, DEFAULT_TEMPERATURE,
  type BiasContext,
  type ScoreWeights,
} from '#agency/selection.scoring'

export { MotorSchemaExecutor } from '#agency/engines/motor.schema.executor'
export { 
  enact,
  modeOf,
  type Enaction,
  type EnactionMode
} from '#agency/execution.primitives'

export { ReafferenceEngine } from '#agency/engines/reafference.engine'
export {
  reconcileInvocation,
  type HostAckResult
} from '#agency/reconcile.learning'

export { AccessGrants, EXPLICIT_EFFECTORS } from '#agency/access.grants'

export {
  distillCompetence, loadCompetence, COMPETENCE_SCHEMA_VERSION,
  type CompetenceSnapshot,
  type DistillOptions,
} from '#agency/competence.codec'

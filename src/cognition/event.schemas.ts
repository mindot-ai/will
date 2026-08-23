// ─────────────────────────────────────────────────────────────
// src/cognition/event.schemas.ts
// ─────────────────────────────────────────────────────────────

/**
 * Central registration of all cognitive event schemas.
 *
 * Import this module once at application startup to register all
 * event types with the globalSchemaRegistry. Importing it multiple
 * times is safe — schemas are idempotent once registered.
 *
 * Schema naming follows the topic scheme: {engine}.{category}.{signal}
 * All payloads are validated as plain objects (structural, not exhaustive).
 */

import { globalSchemaRegistry } from '#cognition/schema.registry'

function isObj( v: unknown ): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray( v )
}
function hasNum( o: Record<string, unknown>, k: string ): string | null {
  return typeof o[ k ] === 'number' ? null : `missing numeric field '${k}'`
}

// ── Regulatory ───────────────────────────────────────────────

globalSchemaRegistry.register({
  type: 'stress.zone.transition', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'zone') ?? hasNum( p, 'load')
  },
})

globalSchemaRegistry.register({
  type: 'energy.level.critical', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'level')
  },
})

globalSchemaRegistry.register({
  type: 'sleep.pressure.critical', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'pressure')
  },
})

globalSchemaRegistry.register({
  type: 'circadian.alertness.shifted', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'alertness')
  },
})

globalSchemaRegistry.register({
  type: 'modulation.degradation.elevated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'attentionDegradation')
  },
})

// ── Perceptual ───────────────────────────────────────────────

globalSchemaRegistry.register({
  type: 'perception.novelty.spike', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'novelty')
  },
})

globalSchemaRegistry.register({
  type: 'social.agents.present', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'activeAgents')
  },
})

globalSchemaRegistry.register({
  type: 'interoception.state.updated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'comfort')
  },
})

globalSchemaRegistry.register({
  type: 'working_memory.capacity.reached', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'capacity') ?? hasNum( p, 'items')
  },
})

// ── Affective ────────────────────────────────────────────────

globalSchemaRegistry.register({
  type: 'emotion.fear.elevated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'fear')
  },
})

globalSchemaRegistry.register({
  type: 'emotion.joy.peak', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'joy')
  },
})

globalSchemaRegistry.register({
  type: 'emotion.awe.experienced', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'awe')
  },
})

globalSchemaRegistry.register({
  type: 'emotion.frustration.elevated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'frustration')
  },
})

globalSchemaRegistry.register({
  type: 'emotion.guilt.elevated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'guilt')
  },
})

globalSchemaRegistry.register({
  type: 'emotion.love.significant', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'love')
  },
})

globalSchemaRegistry.register({
  type: 'emotion.sadness.elevated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'sadness')
  },
})

globalSchemaRegistry.register({
  type: 'affect.state.shifted', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'valence') ?? hasNum( p, 'arousal')
  },
})

// ── Executive ────────────────────────────────────────────────

globalSchemaRegistry.register({
  type: 'goal.state.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'activeCount')
  },
})

globalSchemaRegistry.register({
  type: 'decision.committed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    if( typeof p['actionType'] !== 'string') return "missing string field 'actionType'"
    return hasNum( p, 'confidence')
  },
})

globalSchemaRegistry.register({
  type: 'inhibition.vetoed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    if( !Array.isArray( p['vetoedActions'] ) ) return "missing array field 'vetoedActions'"
    return null
  },
})

globalSchemaRegistry.register({
  type: 'planning.plan.created', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'totalPlans')
  },
})

globalSchemaRegistry.register({
  type: 'task.focus.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'focusTicks')
  },
})


globalSchemaRegistry.register({
  type: 'action.executed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'count')
  },
})

// ── Memory ───────────────────────────────────────────────────

globalSchemaRegistry.register({
  type: 'episode.consolidated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'total')
  },
})

globalSchemaRegistry.register({
  type: 'belief.updated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'total')
  },
})

globalSchemaRegistry.register({
  type: 'memory.decay.applied', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'decayed')
  },
})

globalSchemaRegistry.register({
  type: 'dream.active', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'reactivated')
  },
})

globalSchemaRegistry.register({
  type: 'narrative.updated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'version')
  },
})

// ── Meta-cognitive ───────────────────────────────────────────

globalSchemaRegistry.register({
  type: 'self_model.updated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'version')
  },
})

globalSchemaRegistry.register({
  type: 'confidence.calibrated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'calibrationBias')
  },
})

globalSchemaRegistry.register({
  type: 'bias.detected', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'count')
  },
})

globalSchemaRegistry.register({
  type: 'introspection.insight', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'total')
  },
})

globalSchemaRegistry.register({
  type: 'theory_of_mind.model.updated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'modelsActive')
  },
})

globalSchemaRegistry.register({
  type: 'empathy.resonance', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'activeModels')
  },
})

globalSchemaRegistry.register({
  type: 'reputation.updated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'trackedAgents')
  },
})

// ── Infrastructure ───────────────────────────────────────────

globalSchemaRegistry.register({
  type: 'executive.active', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'tick')
  },
})

globalSchemaRegistry.register({
  type: 'communication.session.active', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'sessionCount')
  },
})

globalSchemaRegistry.register({
  type: 'llm.cost.tick', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'costThisTick')
  },
})

// ── Phase D: cold-start and rich state-change events ─────────

// engine.snapshot — published by every CognitiveEngine on startup
globalSchemaRegistry.register({
  type: 'engine.snapshot', version: 1,
  validate( p ){ return typeof p === 'object' && p !== null ? null : 'payload must be object' },
})

// State-change events — published when a regulatory engine's value changes
// meaningfully. Carry full current state so subscribers can update local copies.

globalSchemaRegistry.register({
  type: 'energy.state.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'level') ?? hasNum( p, 'zoneCode')
  },
})

globalSchemaRegistry.register({
  type: 'sleep.state.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'pressure') ?? hasNum( p, 'intensity')
  },
})

globalSchemaRegistry.register({
  type: 'stress.state.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'load') ?? hasNum( p, 'zoneCode')
  },
})

globalSchemaRegistry.register({
  type: 'circadian.state.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'alertness')
  },
})

globalSchemaRegistry.register({
  type: 'attention.state.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'usage')
  },
})

globalSchemaRegistry.register({
  type: 'attention.regulate', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'effortTarget')
  },
})

globalSchemaRegistry.register({
  type: 'affect.state.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'valence') ?? hasNum( p, 'arousal')
  },
})

globalSchemaRegistry.register({
  type: 'interoception.state.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'comfort')
  },
})

globalSchemaRegistry.register({
  type: 'novelty.state.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'novelty')
  },
})

globalSchemaRegistry.register({
  type: 'memory.state.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return null
  },
})

globalSchemaRegistry.register({
  type: 'metacognition.state.changed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return null
  },
})

// ── Phase E: Global Workspace (Executive broadcast events) ─────

globalSchemaRegistry.register({
  type: 'executive.interpretation.formed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'confidence')
  },
})

globalSchemaRegistry.register({
  type: 'executive.goal.proposed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'count')
  },
})

globalSchemaRegistry.register({
  type: 'executive.self.reflection', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'confidence')
  },
})

globalSchemaRegistry.register({
  type: 'executive.decision.rationale', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'confidence')
  },
})

globalSchemaRegistry.register({
  type: 'executive.prediction.formed', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'confidence')
  },
})

// ── Conversion-enabling schemas ───────────────────────────────
// New events that give subscribers the context they need without
// reaching into shared state.

globalSchemaRegistry.register({
  type: 'goal.blocked', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    if( typeof p['goalId'] !== 'string') return "missing string field 'goalId'"
    return hasNum( p, 'ticksStuck') ?? hasNum( p, 'priority')
  },
})

globalSchemaRegistry.register({
  type: 'goal.achieved', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    if( typeof p['goalId'] !== 'string') return "missing string field 'goalId'"
    return hasNum( p, 'priority') ?? hasNum( p, 'timeToComplete')
  },
})

globalSchemaRegistry.register({
  type: 'goal.abandoned', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    if( typeof p['goalId'] !== 'string') return "missing string field 'goalId'"
    return null
  },
})

globalSchemaRegistry.register({
  type: 'action.outcome', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    if( typeof p['actionType'] !== 'string') return "missing string field 'actionType'"
    if( typeof p['domain']     !== 'string') return "missing string field 'domain'"
    return hasNum( p, 'outcomeQuality')
  },
})

globalSchemaRegistry.register({
  type: 'sleep.begun', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'pressure')
  },
})

globalSchemaRegistry.register({
  type: 'sleep.ended', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'tick')
  },
})

globalSchemaRegistry.register({
  type: 'interaction.occurred', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    if( typeof p['keid'] !== 'string') return "missing string field 'keid'"
    return hasNum( p, 'valence') ?? hasNum( p, 'intensity')
  },
})

globalSchemaRegistry.register({
  type: 'percept.category.updated', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    if( typeof p['category'] !== 'string') return "missing string field 'category'"
    return hasNum( p, 'count')
  },
})

// ── Deliberation cache (fast-path telemetry) ─────────────────
// Published from the ExecutiveEngine's committed path (onReasoningComplete),
// never from inside the pure cache. Lets faculties like the PersonaConsolidator
// react to how automatic the Will is becoming (e.g. a high hit rate could lower
// the deliberate-effort threshold).

globalSchemaRegistry.register({
  type: 'cache.hit', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'confidence') ?? hasNum( p, 'neighborCount')
  },
})

globalSchemaRegistry.register({
  type: 'cache.miss', version: 1,
  validate( p ){
    if( !isObj(p) ) return 'payload must be object'
    return hasNum( p, 'confidence')
  },
})

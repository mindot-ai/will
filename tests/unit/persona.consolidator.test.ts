// ─────────────────────────────────────────────────────────────
// tests/unit/persona.consolidator.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for PersonaConsolidator — the write-back edge of the metacognition
 * cycle (Phase 3). Drives the faculty across consolidation passes through a tiny
 * in-memory state harness that applies its emitted set-commands, so the
 * persona-prior written by one react() is visible to the next.
 *
 * Covers the closed edges:
 *   1. confidence.calibrated  → self-model.minIntervalTicks
 *   2. bias.detected          → introspection.cooldownTicks
 *   3. self_model.updated     → narrator.minIntervalTicks
 *   4. bias.detected (belief)  → semantic.beliefStalenessThreshold
 *   5. bias.detected (memory)  → working-memory.attentionProtection
 *   6. bias.detected          → inhibition.baseInhibitionStrength (↑)
 *   7. introspection.insight   → self-model.minNewExperiences (↓)
 *   8. bias.detected (belief)  → attention.shiftInertia (↓)
 * plus multi-edge-in-one-pass, bounding/decay, determinism, restart round-trip,
 * and that the target engines actually *consume* the prior.
 */

import { describe, it, expect } from 'vitest'
import { PersonaConsolidator } from '#faculties/persona.consolidator'
import { IntrospectionEngine } from '#faculties/introspection.engine'
import { AutobiographicalNarrator } from '#faculties/autobiographical.narrator'
import { readEffectiveParams, PERSONA_PRIOR_ID, PERSONA_PRIOR_TYPE } from '#cognition/persona.prior'
import { createContext } from '#core/utils'
import type { CognitiveEvent } from '#cognition/bus'
import type {
  ReadonlySimulationState, SimulationContext, SimulationEntity,
  Duration, Tick, StateCommands,
} from '#core/types'

const SELF_MODEL    = 'engine-config-self-model'
const INTROSPECTION = 'engine-config-introspection'
const NARRATOR      = 'engine-config-narrator'
const SEMANTIC      = 'engine-config-semantic'
const WORKING_MEM   = 'engine-config-working-memory'
const INHIBITION    = 'engine-config-inhibition'
const ATTENTION     = 'engine-config-attention'
const ctx = createContext('sim', 'run', 1 )
const CONTEXT = {} as unknown as SimulationContext

function evt( type: string, payload: Record<string, unknown> ): CognitiveEvent {
  return { type, salience: 0.5, payload } as unknown as CognitiveEvent
}
const calibrated      = ( bias: number )   => evt('confidence.calibrated', { calibrationBias: bias } )
const biasDetected    = ( newCount: number, types: string[] = [] ) => evt('bias.detected', { count: newCount, newCount, types } )
const selfModelChanged = ( changeMagnitude: number ) => evt('self_model.updated', { version: 2, changeMagnitude } )
const insight          = ( significance: number ) => evt('introspection.insight', { total: 10, significance } )

function configEntity( id: string, params: Record<string, number> ): SimulationEntity {
  return { id, type: 'engine.config', createdAt: 0, updatedAt: 0, metadata: { engine: id, params } } as unknown as SimulationEntity
}

/** In-memory state + command applier — stands in for the state manager. */
class World {
  entities = new Map<string, SimulationEntity>()
  constructor(){
    this.entities.set( SELF_MODEL,    configEntity( SELF_MODEL,    { minIntervalTicks: 200, minNewExperiences: 20 } ) )
    this.entities.set( INTROSPECTION, configEntity( INTROSPECTION, { cooldownTicks: 50, significanceThreshold: 0.4 } ) )
    this.entities.set( NARRATOR,      configEntity( NARRATOR,      { minIntervalTicks: 50, maxNarrativeLength: 5000 } ) )
    this.entities.set( SEMANTIC,      configEntity( SEMANTIC,      { beliefStalenessThreshold: 300, beliefDecayRate: 0.001 } ) )
    this.entities.set( WORKING_MEM,   configEntity( WORKING_MEM,   { attentionProtection: 0.6, baseDecayRate: 0.08 } ) )
    this.entities.set( INHIBITION,    configEntity( INHIBITION,    { baseInhibitionStrength: 0.6, arousalThreshold: 0.6 } ) )
    this.entities.set( ATTENTION,     configEntity( ATTENTION,     { shiftInertia: 0.7, maxFoci: 4 } ) )
  }
  state(): ReadonlySimulationState {
    return { tick: 0, time: 0, entities: this.entities, metrics: new Map() } as unknown as ReadonlySimulationState
  }
  apply( commands: StateCommands ): void {
    for( const e of commands.set ?? [] )
      this.entities.set( e.id, { ...e, createdAt: 0, updatedAt: 0 } as unknown as SimulationEntity )
  }
  delta( configId = SELF_MODEL, param = 'minIntervalTicks'): number {
    const meta = this.entities.get( PERSONA_PRIOR_ID )?.metadata as { priors?: Record<string, Record<string, number>> } | undefined
    return meta?.priors?.[ configId ]?.[ param ] ?? 0
  }
}

async function pass( c: PersonaConsolidator, w: World, tick: number ): Promise<StateCommands> {
  const res = await c.react( 0 as Duration, tick as Tick, w.state(), CONTEXT )
  w.apply( res.commands as StateCommands )
  return res.commands as StateCommands
}

describe('PersonaConsolidator — edge 1: calibration → self-model cadence', () => {
  it('pushes a bounded negative cadence delta when persistently mis-calibrated', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10, cadenceGain: 400, significanceThreshold: 0.05 })
    const w = new World()
    c.onCognitiveEvent( calibrated( 0.4 ) )
    await pass( c, w, 10 )

    expect( w.delta() ).toBeLessThan( 0 )
    expect( w.delta() ).toBeGreaterThanOrEqual( -30 )   // step cap 0.15 × 200
    expect( readEffectiveParams( w.state(), SELF_MODEL ).minIntervalTicks ).toBe( 200 + w.delta() )
  })

  it('leaves the persona untouched for a well-calibrated (sub-threshold) Will', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10, significanceThreshold: 0.05 })
    const w = new World()
    c.onCognitiveEvent( calibrated( 0.01 ) )
    await pass( c, w, 10 )

    expect( w.entities.has( PERSONA_PRIOR_ID ) ).toBe( false )
  })

  it('does not consolidate between interval passes', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 100 })
    const w = new World()
    c.onCognitiveEvent( calibrated( 0.4 ) )

    const early = await pass( c, w, 50 )
    expect( early.set ).toEqual( [] )
    await pass( c, w, 100 )
    expect( w.delta() ).toBeLessThan( 0 )
  })

  it('saturates at the cumulative cap — never diverges', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10, cadenceGain: 400 })
    const w = new World()
    c.onCognitiveEvent( calibrated( 0.9 ) )
    for( let t = 10; t <= 300; t += 10 ) await pass( c, w, t )

    expect( w.delta() ).toBeGreaterThanOrEqual( -100 )   // cumulative cap 0.5 × 200
    expect( w.delta() ).toBeLessThan( -80 )
  })

  it('decays the cadence prior back toward base once calibration recovers', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10, cadenceGain: 400 })
    const w = new World()
    c.onCognitiveEvent( calibrated( 0.6 ) )
    for( let t = 10; t <= 60; t += 10 ) await pass( c, w, t )
    const elevated = w.delta()
    expect( elevated ).toBeLessThan( -40 )

    c.onCognitiveEvent( calibrated( 0 ) )
    for( let t = 70; t <= 160; t += 10 ) await pass( c, w, t )
    expect( Math.abs( w.delta() ) ).toBeLessThan( Math.abs( elevated ) )
  })

  it('is deterministic — identical drive ⇒ identical prior (R2)', async () => {
    async function run(): Promise<number> {
      const c = new PersonaConsolidator({ intervalTicks: 10, cadenceGain: 400 })
      const w = new World()
      for( const [ t, bias ] of [ [ 10, 0.4 ], [ 20, 0.2 ], [ 30, 0 ], [ 40, 0.5 ] ] as const ){
        c.onCognitiveEvent( calibrated( bias ) )
        await pass( c, w, t )
      }
      return w.delta()
    }
    expect( await run() ).toBe( await run() )
  })

  it('the written prior survives a simulated restart (entity round-trip, Option B)', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10, cadenceGain: 400 })
    const w = new World()
    c.onCognitiveEvent( calibrated( 0.5 ) )
    await pass( c, w, 10 )
    const before = readEffectiveParams( w.state(), SELF_MODEL ).minIntervalTicks

    const restored = {
      tick: 0, time: 0,
      entities: new Map( [ ...w.entities.entries() ].map( ([ k, v ]) => [ k, { ...v } as SimulationEntity ] ) ),
      metrics: new Map(),
    } as unknown as ReadonlySimulationState
    expect( readEffectiveParams( restored, SELF_MODEL ).minIntervalTicks ).toBe( before )
  })
})

describe('PersonaConsolidator — edge 2: bias.detected → introspection cadence', () => {
  it('lowers introspection cooldown (bounded) when bias recurs', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( biasDetected( 2 ) )
    await pass( c, w, 10 )

    expect( w.delta( INTROSPECTION, 'cooldownTicks') ).toBeLessThan( 0 )
    expect( w.delta( INTROSPECTION, 'cooldownTicks') ).toBeGreaterThanOrEqual( -7.5 )  // step cap 0.15 × 50
  })

  it('ignores a zero-novelty bias pass (no new biases this scan)', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( biasDetected( 0 ) )
    await pass( c, w, 10 )
    expect( w.entities.has( PERSONA_PRIOR_ID ) ).toBe( false )
  })
})

describe('PersonaConsolidator — edge 3: self_model.updated → narrator cadence', () => {
  it('lowers narrator interval (bounded) on a significant identity change', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( selfModelChanged( 0.5 ) )
    await pass( c, w, 10 )

    expect( w.delta( NARRATOR, 'minIntervalTicks') ).toBeLessThan( 0 )
    expect( w.delta( NARRATOR, 'minIntervalTicks') ).toBeGreaterThanOrEqual( -7.5 )  // step cap 0.15 × 50
  })
})

describe('PersonaConsolidator — edge 4: belief bias → semantic belief-staleness', () => {
  it('lowers beliefStalenessThreshold (bounded) on belief-formation bias', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( biasDetected( 2, [ 'overgeneralization', 'confirmation_bias' ] ) )
    await pass( c, w, 10 )

    expect( w.delta( SEMANTIC, 'beliefStalenessThreshold') ).toBeLessThan( 0 )
    expect( w.delta( SEMANTIC, 'beliefStalenessThreshold') ).toBeGreaterThanOrEqual( -45 )  // step cap 0.15 × 300
  })

  it('a memory-only bias does not touch belief staleness', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( biasDetected( 1, [ 'recency_bias' ] ) )
    await pass( c, w, 10 )
    expect( w.delta( SEMANTIC, 'beliefStalenessThreshold') ).toBe( 0 )
  })
})

describe('PersonaConsolidator — edge 5: memory bias → working-memory protection', () => {
  it('lowers attentionProtection (bounded) on recency/availability bias', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( biasDetected( 1, [ 'recency_bias' ] ) )
    await pass( c, w, 10 )

    expect( w.delta( WORKING_MEM, 'attentionProtection') ).toBeLessThan( 0 )
    expect( w.delta( WORKING_MEM, 'attentionProtection') ).toBeGreaterThanOrEqual( -0.09 )  // step cap 0.15 × 0.6
  })

  it('routes mixed bias types to the right faculties (and aggregate to introspection)', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( biasDetected( 3, [ 'overgeneralization', 'confirmation_bias', 'recency_bias' ] ) )
    await pass( c, w, 10 )

    expect( w.delta( SEMANTIC,      'beliefStalenessThreshold') ).toBeLessThan( 0 )   // 2 belief biases
    expect( w.delta( WORKING_MEM,   'attentionProtection') ).toBeLessThan( 0 )        // 1 memory bias
    expect( w.delta( INTROSPECTION, 'cooldownTicks') ).toBeLessThan( 0 )              // aggregate novelty 3
  })
})

describe('PersonaConsolidator — edge 6: bias.detected → inhibitory control', () => {
  it('raises baseInhibitionStrength (bounded, positive) when bias recurs', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( biasDetected( 2 ) )
    await pass( c, w, 10 )

    const d = w.delta( INHIBITION, 'baseInhibitionStrength')
    expect( d ).toBeGreaterThan( 0 )                 // *raises* control (unlike the cadence edges)
    expect( d ).toBeLessThanOrEqual( 0.09 )          // step cap 0.15 × 0.6
    expect( readEffectiveParams( w.state(), INHIBITION ).baseInhibitionStrength ).toBe( 0.6 + d )
  })

  it('a zero-novelty bias pass does not touch inhibition', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( biasDetected( 0 ) )
    await pass( c, w, 10 )
    expect( w.delta( INHIBITION, 'baseInhibitionStrength') ).toBe( 0 )
  })
})

describe('PersonaConsolidator — edge 7: introspection.insight → self-model evidence gate', () => {
  it('lowers minNewExperiences (bounded) on a productive introspection', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( insight( 3 ) )               // 3 insights (biases + lessons)
    await pass( c, w, 10 )

    const d = w.delta( SELF_MODEL, 'minNewExperiences')
    expect( d ).toBeLessThan( 0 )
    expect( d ).toBeGreaterThanOrEqual( -3 )         // step cap 0.15 × 20
    // …and it is a *different* gate than edge 1's time interval (left untouched here).
    expect( w.delta( SELF_MODEL, 'minIntervalTicks') ).toBe( 0 )
  })

  it('a thin introspection (≤1 insight) does not push the evidence gate', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( insight( 1 ) )
    await pass( c, w, 10 )
    expect( w.delta( SELF_MODEL, 'minNewExperiences') ).toBe( 0 )
  })
})

describe('PersonaConsolidator — edge 8: belief bias → attentional fixation', () => {
  it('lowers attention shiftInertia (bounded) on belief-formation bias', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( biasDetected( 2, [ 'overgeneralization', 'confirmation_bias' ] ) )
    await pass( c, w, 10 )

    const d = w.delta( ATTENTION, 'shiftInertia')
    expect( d ).toBeLessThan( 0 )
    expect( d ).toBeGreaterThanOrEqual( -0.105 )     // step cap 0.15 × 0.7
    expect( readEffectiveParams( w.state(), ATTENTION ).shiftInertia ).toBe( 0.7 + d )
  })

  it('a memory-only bias does not touch attentional inertia', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10 })
    const w = new World()
    c.onCognitiveEvent( biasDetected( 1, [ 'recency_bias' ] ) )
    await pass( c, w, 10 )
    expect( w.delta( ATTENTION, 'shiftInertia') ).toBe( 0 )
  })
})

describe('PersonaConsolidator — multi-edge in one pass', () => {
  it('writes one persona-prior carrying all three target deltas, decaying once', async () => {
    const c = new PersonaConsolidator({ intervalTicks: 10, cadenceGain: 400 })
    const w = new World()
    c.onCognitiveEvent( calibrated( 0.4 ) )
    c.onCognitiveEvent( biasDetected( 2 ) )
    c.onCognitiveEvent( selfModelChanged( 0.5 ) )
    await pass( c, w, 10 )

    expect( w.delta( SELF_MODEL,    'minIntervalTicks') ).toBeLessThan( 0 )
    expect( w.delta( INTROSPECTION, 'cooldownTicks') ).toBeLessThan( 0 )
    expect( w.delta( NARRATOR,      'minIntervalTicks') ).toBeLessThan( 0 )

    const meta = w.entities.get( PERSONA_PRIOR_ID )!.metadata as { version: number }
    expect( meta.version ).toBe( 1 )   // one consolidation = one version bump
    const ent = w.entities.get( PERSONA_PRIOR_ID )!
    expect( ent.type ).toBe( PERSONA_PRIOR_TYPE )
  })
})

// ── Target engines actually consume the prior ────────────────

describe('Edge consumption — introspection reads its effective cooldown', () => {
  function introspectionState( significance: number, cooldownDelta?: number ): ReadonlySimulationState {
    const entities = new Map<string, SimulationEntity>([
      [ INTROSPECTION, configEntity( INTROSPECTION, { cooldownTicks: 50, significanceThreshold: 0.4 } ) ],
    ])
    if( cooldownDelta != null )
      entities.set( PERSONA_PRIOR_ID, {
        id: PERSONA_PRIOR_ID, type: PERSONA_PRIOR_TYPE, createdAt: 0, updatedAt: 0,
        metadata: { priors: { [ INTROSPECTION ]: { cooldownTicks: cooldownDelta } }, version: 1, updatedAtTick: 0 },
      } as unknown as SimulationEntity )
    return { tick: 0, time: 0, entities, metrics: new Map([ [ 'outcome.significance', significance ] ]) } as unknown as ReadonlySimulationState
  }

  it('introspects at base cooldown, but a prior that raises cooldown suppresses it', async () => {
    const introspects = async ( cooldownDelta?: number ): Promise<boolean> => {
      const e = new IntrospectionEngine()
      const res = await e.react( 0 as Duration, 10 as Tick, introspectionState( 0.9, cooldownDelta ), ctx )
      return ( ( res.commands as StateCommands ).set ?? [] ).some( s => s.type === 'introspection')
    }
    expect( await introspects() ).toBe( true )          // gap 110 ≥ base cooldown 50
    expect( await introspects( 200 ) ).toBe( false )     // effective cooldown 250 > 110 → suppressed
  })
})

describe('Edge consumption — narrator reads its effective interval', () => {
  // Single-sourced: narrator reads engine-config-narrator (base 50) ⊕ persona-prior.
  function narratorState( minIntervalDelta?: number ): ReadonlySimulationState {
    const entities = new Map<string, SimulationEntity>([
      [ NARRATOR, configEntity( NARRATOR, { minIntervalTicks: 50, maxNarrativeLength: 5000 } ) ],
    ])
    if( minIntervalDelta != null )
      entities.set( PERSONA_PRIOR_ID, {
        id: PERSONA_PRIOR_ID, type: PERSONA_PRIOR_TYPE, createdAt: 0, updatedAt: 0,
        metadata: { priors: { [ NARRATOR ]: { minIntervalTicks: minIntervalDelta } }, version: 1, updatedAtTick: 0 },
      } as unknown as SimulationEntity )
    return { tick: 0, time: 0, entities, metrics: new Map() } as unknown as ReadonlySimulationState
  }

  it('a prior lowering the interval lets the narrator run sooner than its base cadence', async () => {
    const narrates = async ( minIntervalDelta?: number ): Promise<boolean> => {
      const n = new AutobiographicalNarrator()
      const res = await n.react( 0 as Duration, 40 as Tick, narratorState( minIntervalDelta ), ctx )
      return ( ( res.commands as StateCommands ).set ?? [] ).some( s => s.id === 'self-narrative')
    }
    expect( await narrates() ).toBe( false )        // base 50, 40 < 50 → gated
    expect( await narrates( -20 ) ).toBe( true )    // effective 30 ≤ 40 → runs
  })
})

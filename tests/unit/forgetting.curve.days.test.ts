// ─────────────────────────────────────────────────────────────
// tests/unit/forgetting.curve.days.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * A mind forgets in days, not seconds.
 *
 * The default rate was 0.02 per second — a typical episode gone in about twenty
 * seconds — and a mind woken from its artifact got `1 − memoryPersistence × 0.7`
 * (0.44–0.79) as the absolute rate. A live Will held zero episodes on every one
 * of 2,095 ticks of a 35-minute run: every new memory was pruned within the tick
 * that made it. These pin the rate in the unit it was always meant in.
 */

import { describe, it, expect } from 'vitest'
import { EpisodicConsolidator, type EpisodicMemory } from '#faculties/episodic.consolidator'
import { ForgettingCurve, DEFAULT_FORGETTING_RATE_PER_SECOND } from '#faculties/forgetting.curve'
import { buildEngineConfigEntities } from '#cognition/config.mirror.entities'
import { createContext } from '#core/utils'
import type { ReadonlySimulationState } from '#core/types'

const DAY_MS = 86_400_000
const ctx    = createContext('sim', 'run', 42 )
const awake  = { tick: 1, time: 0, entities: new Map(), metrics: new Map() } as unknown as ReadonlySimulationState

const episode = ( id: string, activationStrength: number ): EpisodicMemory => ({
  id, timestamp: 0, content: { summary: id }, emotionalTags: {},
  affectiveContext: { valence: 0, arousal: 0, dominance: 0 },
  activationStrength, retrievalCount: 0, lastRetrievedAt: null, tags: [], sourceType: 'thought', createdAt: 0,
})

function mind( ...eps: EpisodicMemory[] ){
  const consolidator = new EpisodicConsolidator({ autoIndex: false })
  consolidator.restoreEpisodes( eps )
  const curve = new ForgettingCurve()            // the default rate, nothing configured
  curve.attachConsolidator( consolidator )
  const live = () => consolidator.getAllEpisodes().map( e => e.id )
  const pass = ( ms: number ) => curve.react( ms, 1, awake, ctx )
  return { live, pass }
}

describe('forgetting — in days of running time', () => {
  it('keeps the weakest memory that can exist for three days, and lets it go after', async () => {
    // Born at the consolidation threshold (0.25): the floor of what gets remembered.
    const m = mind( episode('weakest', 0.25 ) )
    await m.pass( 1 * DAY_MS )
    expect( m.live() ).toEqual([ 'weakest' ])
    await m.pass( 1.9 * DAY_MS )                   // 2.9 days in
    expect( m.live() ).toEqual([ 'weakest' ])
    await m.pass( 0.2 * DAY_MS )                   // 3.1 days in
    expect( m.live() ).toEqual([])
  } )

  it('outlives a working day by a wide margin at every strength', async () => {
    const m = mind( episode('typical', 0.43 ), episode('strong', 1.0 ) )
    await m.pass( 8 * 3_600_000 )
    expect( m.live() ).toEqual([ 'typical', 'strong' ])
  } )

  it('is the rate a new mind is born with', () => {
    const mirror = buildEngineConfigEntities( {} as never, 60 ).find( e => e.id === 'engine-config-forgetting')
    expect( mirror!.params['baseForgettingRate'] )
      .toBe( DEFAULT_FORGETTING_RATE_PER_SECOND )
  } )
} )

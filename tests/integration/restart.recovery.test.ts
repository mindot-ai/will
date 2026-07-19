// ─────────────────────────────────────────────────────────────
// tests/integration/restart.recovery.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * MVP F2 — Restart Recovery.
 *
 * Faithful test of the exact recovery path WillStem.createWill() runs on boot:
 *
 *     loadLatestFromStorage()  →  StateManager.restore({ entities: true, metrics: false })
 *
 * A Will is "crashed" mid-run (we discard its StateManager + SnapshotManager) and
 * "restarted" against the SAME storage. We assert the cognitive state a developer
 * cares about — goals, beliefs, episodic memories, autobiographical narrative —
 * survives the restart, while volatile metrics do NOT carry over (they rebuild
 * from tick 1, per the engine's documented restore contract).
 *
 * Uses an in-memory StorageAdapter — no filesystem, no LLM, fully deterministic.
 */

import { describe, it, expect } from 'vitest'
import { DefaultStateManager } from '#core/state.manager'
import { SnapshotManager }     from '#core/snapshot.manager'
import type { StorageAdapter } from '#core/abstracts'
import type { EntityInput }    from '#core/types'

// ── In-memory storage adapter (no filesystem) ──────────────────

function makeMemoryStorage(): StorageAdapter & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    async write( path, content ){ files.set( path, String( content ) ) },
    async read( path ){
      const v = files.get( path )
      if( v === undefined ) throw new Error(`File not found: ${path}`)
      return v
    },
    async readBytes( path ){ return new TextEncoder().encode( await this.read( path ) ) },
    async exists( path ){ return files.has( path ) },
    async delete( path ){ files.delete( path ) },
    async ensureDir(){ /* no-op */ },
  }
}

// ── Representative cognitive entities (real engine type strings) ──

const SEED_ENTITIES: EntityInput[] = [
  {
    id:   'goal-1',
    type: 'goal',
    metadata: { description: 'Build trust with Alice', priority: 8, progress: 0.4, status: 'active' },
  },
  {
    id:   'belief-1',
    type: 'belief',
    metadata: { statement: 'Alice values directness', confidence: 0.72, category: 'social' },
  },
  {
    id:   'episodic-1',
    type: 'episodic_memory',
    metadata: { content: 'Alice thanked me for being honest', emotionalTags: { joy: 0.6 } },
  },
  {
    id:   'narrative-1',
    type: 'narrative_chapter',
    metadata: { story: 'I am learning how to earn trust', version: 3 },
  },
]

const CRASH_TICK   = 847
const PERSIST_PATH = 'data/wills/recovery-test'

/** Seed a StateManager with cognitive state + some volatile metrics at a given tick. */
function seedMind( tick: number ) {
  const sm = new DefaultStateManager()
  sm.updateClock( tick, Date.now() )
  for( const e of SEED_ENTITIES ) sm.setEntity( e )
  // Volatile body-state metrics — these must NOT survive the restart.
  sm.setMetric('energy.level', 0.31 )
  sm.setMetric('affect.valence', -0.2 )
  return sm
}

describe('MVP F2 — restart recovery via snapshot restore', () => {
  it('restores goals, beliefs, memories, and narrative across a crash', async () => {
    const storage = makeMemoryStorage()

    // ── Run + crash ───────────────────────────────────────────
    const before = seedMind( CRASH_TICK )
    const snapMgr = new SnapshotManager({ storage, persistInterval: 1, persistPath: PERSIST_PATH })
    await snapMgr.persistNow( before.snapshot() )

    // "Crash": discard the live managers entirely.

    // ── Restart against the same storage ──────────────────────
    const restartSnapMgr = new SnapshotManager({ storage, persistInterval: 1, persistPath: PERSIST_PATH })
    const restored = await restartSnapMgr.loadLatestFromStorage()
    expect( restored ).toBeDefined()

    const after = new DefaultStateManager()
    // Exact options WillStem.createWill uses: entities yes, metrics no.
    after.restore( restored!, { entities: true, metrics: false } )

    // ── Cognitive state survived ──────────────────────────────
    const goal = after.getEntity('goal-1')
    expect( goal?.type ).toBe('goal')
    expect( goal?.metadata?.description ).toBe('Build trust with Alice')
    expect( goal?.metadata?.progress ).toBe( 0.4 )

    const belief = after.getEntity('belief-1')
    expect( belief?.metadata?.statement ).toBe('Alice values directness')
    expect( belief?.metadata?.confidence ).toBe( 0.72 )

    const memory = after.getEntity('episodic-1')
    expect( memory?.metadata?.content ).toBe('Alice thanked me for being honest')

    const narrative = after.getEntity('narrative-1')
    expect( narrative?.metadata?.story ).toBe('I am learning how to earn trust')
    expect( narrative?.metadata?.version ).toBe( 3 )

    // All four cognitive entities present and accounted for.
    expect( [ ...after.getAllEntities() ] ).toHaveLength( SEED_ENTITIES.length )
  })

  it('does NOT carry volatile metrics across restart (they rebuild from tick 1)', async () => {
    const storage = makeMemoryStorage()

    const before  = seedMind( CRASH_TICK )
    const snapMgr = new SnapshotManager({ storage, persistInterval: 1, persistPath: PERSIST_PATH })
    await snapMgr.persistNow( before.snapshot() )

    const restartSnapMgr = new SnapshotManager({ storage, persistInterval: 1, persistPath: PERSIST_PATH })
    const restored = await restartSnapMgr.loadLatestFromStorage()

    const after = new DefaultStateManager()
    after.restore( restored!, { entities: true, metrics: false } )

    // Metrics intentionally excluded — a freshly-woken Will rebuilds body state.
    expect( after.getMetric('energy.level') ).toBeUndefined()
    expect( after.getMetric('affect.valence') ).toBeUndefined()
  })

  it('starts fresh (no restore) when storage has no prior snapshot', async () => {
    const storage = makeMemoryStorage()
    const snapMgr = new SnapshotManager({ storage, persistInterval: 1, persistPath: PERSIST_PATH })

    const restored = await snapMgr.loadLatestFromStorage()
    expect( restored ).toBeUndefined()   // first boot — createWill proceeds fresh
  })
})

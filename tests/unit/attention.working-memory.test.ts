// ─────────────────────────────────────────────────────────────
// tests/unit/attention.working-memory.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * What the mind attends to stays in mind longer than what it ignores.
 *
 * Working memory has always had the machinery — attended items decay at 40% of
 * the rate, and three ticks of attention start rehearsal — and it read the focus
 * from `attention.focus.metadata.targetEntityId`. AttentionAllocator has always
 * written `entityId`. So since v0.1.0 no item was ever marked attended: every
 * `attendedCount` was 0, and a percept the mind was focused on faded exactly as
 * fast as one it never looked at.
 *
 * Driven double-buffered, as the orchestrator does: every engine reads the same
 * pre-tick snapshot, then all their commands commit.
 */

import { describe, it, expect } from 'vitest'
import { Exteroception } from '#faculties/exteroception'
import { AttentionAllocator } from '#faculties/attention.allocator'
import { WorkingMemory } from '#faculties/working.memory'
import { DefaultStateManager } from '#core/state.manager'
import { createContext } from '#core/utils'
import type { StateCommands } from '#core/types'

const ctx = createContext('sim', 'run', 42 )
type Engine = { react( d: number, t: number, s: unknown, c: unknown ): Promise<{ commands?: StateCommands }> }

/** How many ticks working memory holds the percept of one salient change. */
async function heldFor( withAttention: boolean ){
  const sm = new DefaultStateManager()
  sm.updateClock( 1 as never, 1000 as never )
  sm.applyCommands( { set: [ { id: 'pr-412', type: 'pull_request', metadata: { description: 'PR #412 was merged', salience: 0.9 } } ] } )
  const wm = new WorkingMemory()
  const engines: Engine[] = [ new Exteroception(), ...( withAttention ? [ new AttentionAllocator() ] : [] ), wm ]

  let held = 0, attended = 0
  for( let t = 1; t <= 120; t++ ){
    sm.updateClock( t as never, t * 1000 as never )
    const snapshot = sm.snapshot()
    const results = await Promise.all( engines.map( e => e.react( 1000, t, snapshot, ctx ) ) )
    for( const r of results ) if( r.commands ) sm.applyCommands( r.commands )

    const item = [ ...sm.snapshot().entities.values() ]
      .find( e => e.type === 'working_memory.item' && e.metadata?.['wmType'] === 'percept')
    if( item ){ held++; attended = Math.max( attended, item.metadata!['attendedCount'] as number ) }
  }
  return { held, attended }
}

describe('attention reaches working memory', () => {
  it('marks what the mind is focused on as attended', async () => {
    expect( ( await heldFor( true ) ).attended ).toBeGreaterThan( 0 )
  } )

  it('keeps an attended percept in mind longer than an ignored one', async () => {
    const ignored  = await heldFor( false )
    const attended = await heldFor( true )
    expect( ignored.attended ).toBe( 0 )
    // Unattended: 0.75 at 0.08/s, gone in ~9 ticks. Attended: protected, then rehearsed.
    expect( ignored.held ).toBeLessThan( 12 )
    expect( attended.held ).toBeGreaterThan( ignored.held * 2 )
  } )

  it('still lets it go — attention sustains, it does not pin', async () => {
    // Nothing reinforces a focus whose percept has been swept; it decays, and the
    // item with it. A slot held for the whole run would be a leak, not attention.
    expect( ( await heldFor( true ) ).held ).toBeLessThan( 120 )
  } )
} )

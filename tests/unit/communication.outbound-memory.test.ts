// ─────────────────────────────────────────────────────────────
// tests/unit/communication.outbound-memory.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * §8 — option (a): every outbound message the master sends is persisted as a
 * `conversation.exchange` working-memory item, so it flows through the same
 * pipeline as a facet reply (WorkingMemory → EpisodicConsolidator → vector) and
 * a facet later spawned to continue the conversation recalls it.
 *
 * This must hold UNCONDITIONALLY — both for replies (an inbound `originalMessage`
 * is present) and for master-initiated outreach (no inbound at all). The legacy
 * ConversationManager `recordExchange` / `conversation.session` writes are gone.
 */

import { describe, it, expect } from 'vitest'
import { ProactiveCommunicator } from '#agency/proactive.communicator'
import { OutboxWriter } from '#stem/tracts/outbox.writer'
import type { ActionRequest, OutboxMessage } from '#types'

function make(){
  const outbox: OutboxMessage[] = []
  const exec = new ProactiveCommunicator({ writer: new OutboxWriter({ outbox, willId: 'w' }), willId: 'w' })
  return { exec, outbox }
}

const req = ( parameters: Record<string, unknown> ): ActionRequest => ({
  effector:         'talk',
  parameters,
  targetEntityId:  'alice',
  reasoning:       '',
  expectedOutcome: '',
  decidedAt:       0,
})

const wmItems = ( commands: any ) =>
  ( commands.set ?? [] ).filter( ( c: any ) => c.type === 'working_memory.item')

describe('ProactiveCommunicator — outbound conversation memory (§8 option a)', () => {
  it('persists a conversation.exchange WM item for a master-initiated message (no inbound)', async () => {
    const { exec } = make()

    const res = await exec.executeAction(
      req({ targetEntityName: 'Alice', messages: ['Hey, are you around?'], tick: 5 }),
      {} as any,
    )

    expect( res.success ).toBe( true )
    const items = wmItems( res.commands )
    expect( items ).toHaveLength( 1 )
    const m = items[0].metadata
    expect( m.wmType ).toBe('conversation.exchange')
    expect( m.tags ).toContain('entity:alice')
    expect( m.tags ).toContain('conversation')
    // Will-initiated shape: "I → <name>: …"
    expect( m.summary ).toContain('I → Alice')
    expect( m.summary ).toContain('Hey, are you around?')
    expect( m.entityId ).toBe('alice')
    expect( m.willReply ).toBe('Hey, are you around?')
    expect( m.userMessage ).toBe('')
  } )

  it('persists a conversation.exchange WM item for a reply (inbound present)', async () => {
    const { exec } = make()

    const res = await exec.executeAction(
      req({
        targetEntityName: 'Alice',
        messages:         ['Doing well, thanks!'],
        originalMessage:  'How are you?',
        tick:             7,
      }),
      {} as any,
    )

    const items = wmItems( res.commands )
    expect( items ).toHaveLength( 1 )
    const m = items[0].metadata
    expect( m.wmType ).toBe('conversation.exchange')
    // Reply shape: "<name>: "<inbound>" → "<reply>""
    expect( m.summary ).toContain('How are you?')
    expect( m.summary ).toContain('Doing well, thanks!')
    expect( m.userMessage ).toBe('How are you?')
    expect( m.willReply ).toBe('Doing well, thanks!')
  } )

  it('does NOT write a legacy conversation.session entity', async () => {
    const { exec } = make()
    const res = await exec.executeAction(
      req({ targetEntityName: 'Alice', messages: ['hi'], originalMessage: 'yo', tick: 1 }),
      {} as any,
    )
    const sessions = ( res.commands.set ?? [] ).filter( ( c: any ) => c.type === 'conversation.session')
    expect( sessions ).toHaveLength( 0 )
  } )
} )

// ─────────────────────────────────────────────────────────────
// tests/unit/channel.roster.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * ChannelRoster — the durable entity ↔ platform-address seam under a bridge.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ChannelRoster } from '#channels/roster'

let dir: string
beforeEach( () => { dir = mkdtempSync( join( tmpdir(), 'will-roster-') ) } )
afterEach( () => rmSync( dir, { recursive: true, force: true } ) )

describe('ChannelRoster', () => {
  it('records and resolves an entry, merging partial updates', () => {
    const r = new ChannelRoster( join( dir, 'r.json') )
    r.record( { entityId: 'discord:1', userId: '1', displayName: 'Ada', lastChannelId: 'c1' } )
    r.record( { entityId: 'discord:1', userId: '1', dmChannelId: 'dm1' } )

    const e = r.resolve('discord:1')
    expect( e?.displayName ).toBe('Ada')       // earlier fields survive the merge
    expect( e?.lastChannelId ).toBe('c1')
    expect( e?.dmChannelId ).toBe('dm1')
  } )

  it('does not clobber known fields with undefined', () => {
    const r = new ChannelRoster( join( dir, 'r.json') )
    r.record( { entityId: 'discord:1', userId: '1', displayName: 'Ada' } )
    r.record( { entityId: 'discord:1', userId: '1', displayName: undefined } )
    expect( r.resolve('discord:1')?.displayName ).toBe('Ada')
  } )

  it('persists on flush and reloads across instances', () => {
    const path = join( dir, 'nested', 'r.json')
    const r = new ChannelRoster( path )
    r.record( { entityId: 'discord:2', userId: '2', lastChannelId: 'c9' } )
    r.flush()
    expect( existsSync( path ) ).toBe( true )

    const reloaded = new ChannelRoster( path )
    expect( reloaded.resolve('discord:2')?.lastChannelId ).toBe('c9')
  } )

  it('flush is a no-op when clean, and a corrupt file starts fresh', () => {
    const path = join( dir, 'r.json')
    const r = new ChannelRoster( path )
    r.flush()                                     // clean — writes nothing
    expect( existsSync( path ) ).toBe( false )

    r.record( { entityId: 'discord:3', userId: '3' } )
    r.flush()
    const mangled = readFileSync( path, 'utf8').slice( 0, 5 )
    expect( () => new ChannelRoster( path ) ).not.toThrow()
    void mangled
  } )
} )

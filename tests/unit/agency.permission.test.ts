// ─────────────────────────────────────────────────────────────
// tests/unit/agency.permission.test.ts
// ─────────────────────────────────────────────────────────────
// The agency-native permission layer. Preserves effectorRegistry's grant
// semantics exactly: the communication surface is closed by default; everything
// else is freely available; grants are runtime-reconfigurable.

import { describe, it, expect } from 'vitest'
import { AccessGrants, EXPLICIT_EFFECTORS } from '#agency/access.grants'

describe('AccessGrants — permission semantics', () => {
  it('allows non-explicit effectors freely, denies the communication surface by default', () => {
    const g = new AccessGrants()
    expect( g.isAllowed('observe') ).toBe( true )    // not on the explicit surface
    expect( g.isAllowed('reflect') ).toBe( true )
    for( const name of EXPLICIT_EFFECTORS )
      expect( g.isAllowed( name ) ).toBe( false )       // closed by default
  })

  it('seeds grants from the resolved allow-list (ignoring non-explicit names)', () => {
    const g = new AccessGrants( [ 'listen', 'talk', 'observe' ] )
    expect( g.isAllowed('listen') ).toBe( true )
    expect( g.isAllowed('talk') ).toBe( true )
    expect( g.isAllowed('text') ).toBe( false )
    expect( g.granted().sort() ).toEqual( [ 'listen', 'talk' ] )   // 'observe' not tracked
  })

  it('grants and revokes at runtime', () => {
    const g = new AccessGrants()
    g.allow('text')
    expect( g.isAllowed('text') ).toBe( true )
    g.revoke('text')
    expect( g.isAllowed('text') ).toBe( false )
    g.allow('observe')                               // non-explicit grant is a no-op
    expect( g.granted() ).toEqual( [] )
  })

  it('setAllowed replaces the whole grant set', () => {
    const g = new AccessGrants( [ 'listen', 'talk' ] )
    g.setAllowed( [ 'broadcast' ] )
    expect( g.isAllowed('listen') ).toBe( false )
    expect( g.isAllowed('broadcast') ).toBe( true )
    g.setAllowed( null )
    expect( g.granted() ).toEqual( [] )
  })
})

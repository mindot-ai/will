// ─────────────────────────────────────────────────────────────
// tests/unit/serve.http.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * The HTTP sidecar (`will serve`) — a Will exposed to any language, holding
 * the subject paradigm: POST /perceive answers 202 delivered-not-answered,
 * GET /next-utterance reports silence as a 200 outcome (never an error),
 * GET /state observes, POST /save checkpoints without stopping, and
 * GET /utterances streams projections over SSE. Exercised with real fetch
 * against an ephemeral port.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { Will } from '#sdk/will'
import { buildWillHttpServer } from '#root/serve/server'
import { setLogger, resetLogger } from '#core/logger'

setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } )

const PMA_PATH = join( tmpdir(), `will-serve-test-${ process.pid }.pma.json`)

let will:   Will
let server: Server
let base:   string

beforeAll( async () => {
  will = await Will.create( {
    name: 'Echo', identity: { prompt: 'I am Echo.' },
    llm: 'mock', anatomy: 'mind', tickMs: 10, seed: 7,
  } )
  server = buildWillHttpServer( will, { pmaPath: PMA_PATH } )
  await new Promise<void>( r => server.listen( 0, '127.0.0.1', () => r() ) )
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${ addr.port }`
}, 30_000 )

afterAll( async () => {
  await new Promise<void>( r => server.close( () => r() ) )
  await will.stop()
  rmSync( PMA_PATH, { force: true } )
  resetLogger()
} )

describe('Will over HTTP', () => {
  it('GET /health reports the living mind', async () => {
    const r = await fetch(`${ base }/health`)
    expect( r.status ).toBe( 200 )
    const h = await r.json() as { ok: boolean; name: string; tick: number }
    expect( h.ok ).toBe( true )
    expect( h.name ).toBe('Echo')
    expect( h.tick ).toBeGreaterThan( 0 )
  } )

  it('GET /state returns a well-formed inner-state snapshot', async () => {
    const s = await ( await fetch(`${ base }/state`) ).json() as
      { tick: number; metrics: { energy: number }; goals: unknown[]; narrative: string }
    expect( s.tick ).toBeGreaterThan( 0 )
    expect( s.metrics.energy ).toBeGreaterThan( 0 )
    expect( Array.isArray( s.goals ) ).toBe( true )
    expect( typeof s.narrative ).toBe('string')
  } )

  // Before any perceive — asserts save's non-destructiveness on the clean
  // baseline cadence (conversation processing changes tick pacing).
  it('POST /save checkpoints the living mind — non-destructively', async () => {
    const r = await fetch(`${ base }/save`, { method: 'POST' } )
    expect( r.status ).toBe( 200 )
    expect( ( await r.json() as { path: string } ).path ).toBe( PMA_PATH )
    expect( existsSync( PMA_PATH ) ).toBe( true )
    expect( ( JSON.parse( readFileSync( PMA_PATH, 'utf8') ) as { willName: string } ).willName ).toBe('Echo')

    const t0 = ( await ( await fetch(`${ base }/state`) ).json() as { tick: number } ).tick
    await new Promise( r => setTimeout( r, 150 ) )
    const t1 = ( await ( await fetch(`${ base }/state`) ).json() as { tick: number } ).tick
    expect( t1 ).toBeGreaterThan( t0 )   // still ticking after the checkpoint
  } )

  it('POST /perceive delivers (202) — not answers', async () => {
    const r = await fetch(`${ base }/perceive`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify( { text: 'Hello there.', from: 'ada', speaker: 'Ada' } ),
    } )
    expect( r.status ).toBe( 202 )
    const body = await r.json() as { delivered: boolean; tick: number }
    expect( body.delivered ).toBe( true )
    expect( body.tick ).toBeGreaterThan( 0 )
  } )

  it('POST /perceive without text is a 400', async () => {
    const r = await fetch(`${ base }/perceive`, { method: 'POST', body: '{}' } )
    expect( r.status ).toBe( 400 )
  } )

  it('GET /next-utterance reports silence as a 200 outcome, never an error', async () => {
    // Nobody ever addressed "ghost" — the Will has no reason to speak to it.
    const r = await fetch(`${ base }/next-utterance?within_ms=200&from=ghost`)
    expect( r.status ).toBe( 200 )
    const body = await r.json() as { silence?: boolean; waitedMs?: number }
    expect( body.silence ).toBe( true )
    expect( body.waitedMs ).toBe( 200 )
  } )

  it('GET /utterances opens an SSE stream and says hello', async () => {
    const ctrl = new AbortController()
    const r = await fetch(`${ base }/utterances`, { signal: ctrl.signal } )
    expect( r.status ).toBe( 200 )
    expect( r.headers.get('content-type') ).toBe('text/event-stream')

    const reader  = r.body!.getReader()
    const { value } = await reader.read()
    const first = new TextDecoder().decode( value )
    expect( first ).toContain('event: hello')
    expect( first ).toContain('"name":"Echo"')
    ctrl.abort()
  } )

  it('unknown routes 404 with the route list (no ask()-shaped route exists)', async () => {
    const r = await fetch(`${ base }/ask`, { method: 'POST', body: '{}' } )
    expect( r.status ).toBe( 404 )
    const body = await r.json() as { routes: string[] }
    expect( body.routes.join(' ') ).toContain('/perceive')
    expect( body.routes.join(' ') ).not.toContain('/ask')
  } )
} )

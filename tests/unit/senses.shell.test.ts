// ─────────────────────────────────────────────────────────────
// tests/unit/senses.shell.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Unit tests for the four shell sense engines and ThreadDigestManager.
 *
 * Shell engines:
 *   - correct domain / name / snapshot()
 *   - publishes() declares the right percept event type
 *   - ingest() with a matching kind logs a warning but does not throw
 *   - ingest() with a non-matching kind returns silently (no warning)
 *
 * ThreadDigestManager:
 *   - append() stores formatted "role: content" lines
 *   - getDigest() returns correct header + lines
 *   - getDigest() returns '' for an unknown / empty thread
 *   - append() trims to MAX_TURNS (5) oldest-first
 *   - each thread is isolated
 *   - clear() removes the thread's history
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { VisionEngine }          from '#senses/vision.engine'
import { SomatosensationEngine } from '#senses/somatosensation.engine'
import { OlfactionEngine }       from '#senses/olfaction.engine'
import { GustationEngine }       from '#senses/gustation.engine'
import { ThreadDigestManager }   from '#senses/audition.engine/engine'
import type { SensoryInput }     from '#senses/index'

// ── Helpers ──────────────────────────────────────────────────

/** Every shell input here is ordinary world traffic — provenance is not what these test. */
function makeInput<T extends Omit<SensoryInput, 'provenance'>>( overrides: T ): T & { provenance: 'exafferent' } {
  return { ...overrides, provenance: 'exafferent' }
}

const TEXT_INPUT = makeInput( { kind: 'text' as const, entityId: 'e1', threadId: 't1', content: 'hello' } )

// ── VisionEngine ──────────────────────────────────────────────

describe('VisionEngine (shell)', () => {
  let engine: VisionEngine
  beforeEach( () => { engine = new VisionEngine() } )

  it('has domain "vision" and name "vision-engine"', () => {
    expect( engine.domain ).toBe('vision')
    expect( engine.name ).toBe('vision-engine')
  } )

  it('snapshot() reports { domain: "vision", status: "shell" }', () => {
    expect( engine.snapshot() ).toMatchObject( { domain: 'vision', status: 'shell' } )
  } )

  it('publishes() declares senses.vision.percept v1', () => {
    const schemas = engine.publishes()
    expect( schemas ).toHaveLength( 1 )
    expect( schemas[0]?.type ).toBe('senses.vision.percept')
    expect( schemas[0]?.version ).toBe( 1 )
  } )

  it('subscribes() returns empty array', () => {
    expect( engine.subscribes() ).toEqual( [] )
  } )

  it('ingest(image) logs a warning and does not throw', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    const input = makeInput( { kind: 'image' as const, entityId: 'e1', data: Buffer.from(''), mimeType: 'image/png' } )
    await expect( engine.ingest( input ) ).resolves.toBeUndefined()
    expect( warn ).toHaveBeenCalledWith( expect.stringContaining('vision-engine') )
    warn.mockRestore()
  } )

  it('ingest(video) logs a warning and does not throw', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    const input = makeInput( { kind: 'video' as const, entityId: 'e1', frames: [], durationMs: 1000 } )
    await expect( engine.ingest( input ) ).resolves.toBeUndefined()
    expect( warn ).toHaveBeenCalled()
    warn.mockRestore()
  } )

  it('ingest(non-visual kind) returns silently without warning', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    await expect( engine.ingest( TEXT_INPUT ) ).resolves.toBeUndefined()
    expect( warn ).not.toHaveBeenCalled()
    warn.mockRestore()
  } )
} )

// ── SomatosensationEngine ─────────────────────────────────────

describe('SomatosensationEngine (shell)', () => {
  let engine: SomatosensationEngine
  beforeEach( () => { engine = new SomatosensationEngine() } )

  it('has domain "somatosensation"', () => {
    expect( engine.domain ).toBe('somatosensation')
  } )

  it('snapshot() reports status "shell"', () => {
    expect( engine.snapshot() ).toMatchObject( { status: 'shell' } )
  } )

  it('publishes() declares senses.somatosensation.percept', () => {
    expect( engine.publishes()[0]?.type ).toBe('senses.somatosensation.percept')
  } )

  it('ingest(webhook) warns and does not throw', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    const input = makeInput( { kind: 'webhook' as const, source: 'github', payload: {}, headers: {} } )
    await expect( engine.ingest( input ) ).resolves.toBeUndefined()
    expect( warn ).toHaveBeenCalledWith( expect.stringContaining('somatosensation-engine') )
    warn.mockRestore()
  } )

  it('ingest(system) warns and does not throw', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    const input = makeInput( { kind: 'system' as const, signal: 'STARTUP', data: {} } )
    await expect( engine.ingest( input ) ).resolves.toBeUndefined()
    expect( warn ).toHaveBeenCalled()
    warn.mockRestore()
  } )

  it('ingest(non-soma kind) returns silently', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    await expect( engine.ingest( TEXT_INPUT ) ).resolves.toBeUndefined()
    expect( warn ).not.toHaveBeenCalled()
    warn.mockRestore()
  } )
} )

// ── OlfactionEngine ───────────────────────────────────────────

describe('OlfactionEngine (shell)', () => {
  let engine: OlfactionEngine
  beforeEach( () => { engine = new OlfactionEngine() } )

  it('has domain "olfaction"', () => {
    expect( engine.domain ).toBe('olfaction')
  } )

  it('snapshot() reports status "shell"', () => {
    expect( engine.snapshot() ).toMatchObject( { status: 'shell' } )
  } )

  it('publishes() declares senses.olfaction.percept', () => {
    expect( engine.publishes()[0]?.type ).toBe('senses.olfaction.percept')
  } )

  it('ingest(ambient) warns and does not throw', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    const input = makeInput( { kind: 'ambient' as const, metricKey: 'cpu', value: 0.8, trend: 'rising' as const } )
    await expect( engine.ingest( input ) ).resolves.toBeUndefined()
    expect( warn ).toHaveBeenCalledWith( expect.stringContaining('olfaction-engine') )
    warn.mockRestore()
  } )

  it('ingest(background) warns and does not throw', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    const input = makeInput( { kind: 'background' as const, category: 'idle-mode', data: {} } )
    await expect( engine.ingest( input ) ).resolves.toBeUndefined()
    expect( warn ).toHaveBeenCalled()
    warn.mockRestore()
  } )

  it('ingest(non-olfactory kind) returns silently', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    await expect( engine.ingest( TEXT_INPUT ) ).resolves.toBeUndefined()
    expect( warn ).not.toHaveBeenCalled()
    warn.mockRestore()
  } )
} )

// ── GustationEngine ───────────────────────────────────────────

describe('GustationEngine (shell)', () => {
  let engine: GustationEngine
  beforeEach( () => { engine = new GustationEngine() } )

  it('has domain "gustation"', () => {
    expect( engine.domain ).toBe('gustation')
  } )

  it('snapshot() reports status "shell"', () => {
    expect( engine.snapshot() ).toMatchObject( { status: 'shell' } )
  } )

  it('publishes() declares senses.gustation.percept', () => {
    expect( engine.publishes()[0]?.type ).toBe('senses.gustation.percept')
  } )

  it('ingest(self-eval) warns and does not throw', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    const input = makeInput( { kind: 'self-eval' as const, context: 'post-action', trigger: 'auto' } )
    await expect( engine.ingest( input ) ).resolves.toBeUndefined()
    expect( warn ).toHaveBeenCalledWith( expect.stringContaining('gustation-engine') )
    warn.mockRestore()
  } )

  it('ingest(assessment) warns and does not throw', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    const input = makeInput( { kind: 'assessment' as const, checkType: 'identity-alignment' } )
    await expect( engine.ingest( input ) ).resolves.toBeUndefined()
    expect( warn ).toHaveBeenCalled()
    warn.mockRestore()
  } )

  it('ingest(non-gustatory kind) returns silently', async () => {
    const warn = vi.spyOn( console, 'warn').mockImplementation( () => {} )
    await expect( engine.ingest( TEXT_INPUT ) ).resolves.toBeUndefined()
    expect( warn ).not.toHaveBeenCalled()
    warn.mockRestore()
  } )
} )

// ── ThreadDigestManager ───────────────────────────────────────

describe('ThreadDigestManager', () => {
  let mgr: ThreadDigestManager
  beforeEach( () => { mgr = new ThreadDigestManager() } )

  it('getDigest() returns empty string for an unknown thread', () => {
    expect( mgr.getDigest('unknown') ).toBe('')
  } )

  it('append() stores formatted "role: content" line', () => {
    mgr.append('thread-1', 'user', 'Hello there')
    expect( mgr.getDigest('thread-1') ).toContain('user: Hello there')
  } )

  it('append() stores will role correctly', () => {
    mgr.append('thread-1', 'will', 'Hi back')
    expect( mgr.getDigest('thread-1') ).toContain('will: Hi back')
  } )

  it('getDigest() header shows turn count (plural)', () => {
    mgr.append('thread-1', 'user', 'A')
    mgr.append('thread-1', 'will', 'B')
    expect( mgr.getDigest('thread-1') ).toContain('[Thread — last 2 turns]')
  } )

  it('getDigest() uses singular "turn" for a single entry', () => {
    mgr.append('thread-1', 'user', 'Only one')
    expect( mgr.getDigest('thread-1') ).toContain('last 1 turn]')
  } )

  it('append() trims to MAX_TURNS (5) — oldest entries removed first', () => {
    for( let i = 1; i <= 7; i++ )
      mgr.append('thread-1', 'user', `msg-${i}`)

    const digest = mgr.getDigest('thread-1')
    expect( digest ).not.toContain('msg-1')
    expect( digest ).not.toContain('msg-2')
    expect( digest ).toContain('msg-3')
    expect( digest ).toContain('msg-7')
    expect( digest ).toContain('[Thread — last 5 turns]')
  } )

  it('content is truncated to 200 characters', () => {
    const long = 'x'.repeat( 300 )
    mgr.append('thread-1', 'user', long )
    const digest = mgr.getDigest('thread-1')
    expect( digest ).toContain('user: ' + 'x'.repeat( 200 ) )
    expect( digest ).not.toContain('x'.repeat( 201 ) )
  } )

  it('threads are isolated from each other', () => {
    mgr.append('thread-a', 'user', 'alpha')
    mgr.append('thread-b', 'user', 'beta')

    const a = mgr.getDigest('thread-a')
    const b = mgr.getDigest('thread-b')

    expect( a ).toContain('alpha')
    expect( a ).not.toContain('beta')
    expect( b ).toContain('beta')
    expect( b ).not.toContain('alpha')
  } )

  it('clear() removes all history for the thread', () => {
    mgr.append('thread-1', 'user', 'something')
    mgr.clear('thread-1')
    expect( mgr.getDigest('thread-1') ).toBe('')
  } )

  it('clear() on unknown thread does not throw', () => {
    expect( () => mgr.clear('nonexistent') ).not.toThrow()
  } )

  it('messages appear in append order within digest', () => {
    mgr.append('thread-1', 'user', 'first')
    mgr.append('thread-1', 'will', 'second')
    mgr.append('thread-1', 'user', 'third')

    const digest = mgr.getDigest('thread-1')
    const firstIdx  = digest.indexOf('first')
    const secondIdx = digest.indexOf('second')
    const thirdIdx  = digest.indexOf('third')

    expect( firstIdx ).toBeGreaterThanOrEqual( 0 )
    expect( firstIdx ).toBeLessThan( secondIdx )
    expect( secondIdx ).toBeLessThan( thirdIdx )
  } )
} )

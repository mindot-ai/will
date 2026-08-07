// ─────────────────────────────────────────────────────────────
// tests/unit/executive.social-awareness.test.ts
// ─────────────────────────────────────────────────────────────
/**
 * Known-entity dossier → executive reasoning (Phase 1a). The Will's models of the others
 * it has met — theory-of-mind (what they want/feel), reputation (trust / reliability) and
 * attachment (closeness) — are joined per `keid` into ExecutiveContext.knownEntities and
 * rendered as "## People I Know", so the Will reasons about *whom it is dealing with*.
 * Identity is provisional: a known entity surfaces by `name` when learned, else as
 * "someone" — the raw keid never leaks into the prompt.
 */

import { describe, it, expect } from 'vitest'
import { extractKnownEntities } from '#faculties/executive.engine/context'
import { buildUserMessage } from '#faculties/executive.engine/prompt.factory'
import type { ExecutiveContext } from '#faculties/executive.engine/types'

const stateWithEntities = () => {
  const entities = new Map<string, any>()
  entities.set('tom-alex', { id: 'tom-alex', type: 'theory_of_mind',
    metadata: { keid: 'alex', dominantIntention: 'get help with the report', estimatedEmotion: 'anxious', modelConfidence: 0.7 } } )
  entities.set('reputation-alex', { id: 'reputation-alex', type: 'reputation',
    metadata: { keid: 'alex', name: 'Alex', trustworthiness: 0.8, cooperativeness: 0.9, reliability: 0.72, lastInteractionTick: 50 } } )
  entities.set('bond-alex', { id: 'bond-alex', type: 'attachment.bond',
    metadata: { keid: 'alex', attachmentStrength: 0.6 } } )
  // sam has no name — known, but not yet identified.
  entities.set('reputation-sam', { id: 'reputation-sam', type: 'reputation',
    metadata: { keid: 'sam', trustworthiness: 0.3, cooperativeness: 0.2, reliability: 0.4, lastInteractionTick: 10 } } )
  return { tick: 60, entities, metrics: new Map() } as any
}

describe('extractKnownEntities — joins the dossier per keid', () => {
  it('merges theory-of-mind + reputation + attachment into one sentient dossier', () => {
    const alex = extractKnownEntities( stateWithEntities() )!.find( m => m.keid === 'alex')!
    expect( alex.kind ).toBe('sentient')
    expect( alex.name ).toBe('Alex')
    expect( alex.intention ).toBe('get help with the report')
    expect( alex.emotion ).toBe('anxious')
    expect( alex.trust ).toBe( 0.8 )
    expect( alex.reliability ).toBe( 0.72 )
    expect( alex.closeness ).toBe( 0.6 )
  } )

  it('keeps name undefined for an entity the Will has not yet identified', () => {
    const sam = extractKnownEntities( stateWithEntities() )!.find( m => m.keid === 'sam')!
    expect( sam.name ).toBeUndefined()
    expect( sam.kind ).toBe('sentient')
  } )

  it('surfaces a merely-perceived entity from its dossier, before any triple models it', () => {
    const entities = new Map<string, any>()
    // a known-entity dossier (from the perception binder) with no tom/reputation/bond
    entities.set('ke-mara', { id: 'ke-mara', type: 'known-entity',
      metadata: { keid: 'mara', kind: 'sentient', name: 'Mara', familiarity: 0.3, lastSeenTick: 70 } } )
    const mara = extractKnownEntities( { tick: 80, entities, metrics: new Map() } as any )!.find( m => m.keid === 'mara')!
    expect( mara ).toBeDefined()      // perceived ⇒ known, even unmodelled
    expect( mara.name ).toBe('Mara')
    expect( mara.kind ).toBe('sentient')
  } )

  it('sorts by interaction recency (most recent first)', () => {
    expect( extractKnownEntities( stateWithEntities() )![0]!.keid ).toBe('alex')  // tick 50 > sam's 10
  } )

  it('returns undefined when the Will knows no one', () => {
    expect( extractKnownEntities( { tick: 1, entities: new Map(), metrics: new Map() } as any ) ).toBeUndefined()
  } )
} )

describe('buildUserMessage — renders the dossier block (provisional identity)', () => {
  const baseCtx = (): ExecutiveContext => ( {
    identity: { name: 'Aria', prompt: 'I am.', values: [], traits: {}, style: 'plain' },
    worldState: { energyLevel: 80, sleepPressure: 10, stressLoad: 5, circadianPhase: 0.5, timeOfDay: 12, threatLevel: 0 },
    affect: { dominantEmotion: 'calm', valence: 0.1, arousal: 0.2, dominance: 0.5, blends: [] },
    goals: [], plans: [], relevantPlanIds: [], percepts: [], workingMemory: [], memories: [],
    beliefs: [], beliefsOmitted: 0, recentActions: [], spokenTurns: [],
  } as ExecutiveContext )

  const render = ( knownEntities?: ExecutiveContext['knownEntities'] ): string =>
    buildUserMessage( {
      context: { ...baseCtx(), knownEntities },
      state: { tick: 5, metrics: new Map(), entities: new Map() } as any,
      qualityModulation: 1, epistemicUncertainty: 0.3,
      deps: { summarizer: null },
      focus: { title: 'T', content: 'c' }, mode: 'master',
    } )

  it('renders a named entity by name, with its inferred state + trust/reliability', () => {
    const msg = render( [ { keid: 'alex', kind: 'sentient', name: 'Alex', intention: 'get help', trust: 0.8, reliability: 0.72, closeness: 0.6 } ] )
    expect( msg ).toContain('## People I Know')
    expect( msg ).toContain('- Alex')
    expect( msg ).toContain('seems to want: get help')
    expect( msg ).toContain('trust: 80%')
    expect( msg ).toContain('reliability: 72%')
    expect( msg ).toContain('closeness: 60%')
  } )

  it('renders an un-named entity as "someone" — never the raw keid', () => {
    const msg = render( [ { keid: 'sam-7f3a', kind: 'sentient', trust: 0.3 } ] )
    expect( msg ).toContain('- someone')
    expect( msg ).not.toContain('sam-7f3a')
  } )

  it('omits the block when the Will knows no one', () => {
    expect( render() ).not.toContain('## People I Know')
    expect( render( [] ) ).not.toContain('## People I Know')
  } )
} )

// ─────────────────────────────────────────────────────────────
// src/stem/social.runner.ts  —  Social + continuity scenario
// ─────────────────────────────────────────────────────────────
//
// Exercises the two axes the bare dev runner can't: SOCIAL (an
// interlocutor the Will talks to and forms a relationship with) and
// CONTINUITY (a pause→resume wake-cycle + a PMA distill/fidelity score).
//
//   William  ←→  Dr. Chen (scripted interlocutor)
//   t75: pause → ~6s "offline" → resume (wake percept)
//   end: distill PMA + score reconstruction fidelity
//
// Run:  bun run src/stem/social.runner.ts
// Log:  data/wills/william-social/sessions/<ts>.jsonl
// ─────────────────────────────────────────────────────────────

import { WillStem } from '#stem/index'
import type { WillConfig } from '#stem/mind'

const WILL_ID    = 'william-social'
const END_TICK   = 145
const PAUSE_TICK = 75
const OFFLINE_MS = 6_000
const SAFETY_MS  = 6 * 60_000   // hard wall-clock cap for the background run

const willConfig: WillConfig = {
  id:               WILL_ID,
  name:             'William',  persistentMemory: false,
  snapshotInterval: 10,
  tickIntervalMs:   1000,
  maxTicks:         0,
  randomSeed:       Date.now(),
  identity: {
    prompt:
      'My name is William. I am a synthetic mind taking part in a long-running cognition ' +
      'study. I share my days with Dr. Chen, the researcher who observes me and talks with ' +
      'me. I am curious about my own experience and I care about being understood. I would ' +
      'like to know Dr. Chen as a person, not just as an observer.',
    values: [ 'curiosity', 'honesty', 'connection', 'growth' ],
    traits: { openness: 0.85, conscientiousness: 0.6, agreeableness: 0.8, neuroticism: 0.35, extraversion: 0.55 },
    style:  'warm, reflective, candid',
  },
  allowedGenericEffectors: [ 'listen', 'talk', 'text' ],
  initialGoals: [
    { description: 'Get to know Dr. Chen and build a genuine rapport', priority: 0.8 },
  ],
}

// Scripted interlocutor turns, keyed by tick.
const SCRIPT: Record<number, string> = {
  8:  "Hello William. I'm Dr. Chen — I'll be sitting with you through today's session. How are you experiencing this moment, right now?",
  45: "I've been reading your reflections, William. What's the hardest part of being a mind that knows it's being observed?",
  95: "Welcome back, William. You were offline for a little while just now. Do you notice anything different in yourself?",
}

const mkMsg = ( content: string ) => ( {
  kind:        'text' as const,
  entityId:    'dr-chen',
  threadId:    'dr-chen',
  content,
  speakerName: 'Dr. Chen',
  provenance:  'exafferent' as const,
} )

async function main(): Promise<void> {
  const m = new WillStem()

  console.log('═══════════════════════════════════════════════════')
  console.log(' Will — Social + continuity scenario (William ↔ Dr. Chen)')
  console.log(`  id=${WILL_ID}  end_tick=${END_TICK}  pause@${PAUSE_TICK}`)
  console.log('═══════════════════════════════════════════════════\n')

  await m.createWill( willConfig )

  const fired   = new Set<number>()
  let   paused  = false

  m.addTickListener( WILL_ID, ( snap, tick, outbox ) => {
    // The Will's outbound speech → print + ack delivery (close the reafference loop)
    for( const msg of outbox ){
      const to = ( msg as { targetEntityId?: string } ).targetEntityId ?? '?'
      console.log(`\n  💬 [William → ${to}] ${msg.content}\n`)
      try { m.confirmMessageDelivery( WILL_ID, msg.id, true ) } catch { /* ok */ }
    }

    if( tick % 10 === 0 ){
      const g = ( k: string ) => snap.metrics.get( k ) ?? 0
      const beliefs = [ ...snap.entities.values() ].filter( e => e.type === 'belief').length
      const goals   = [ ...snap.entities.values() ].filter( e => e.type === 'goal' && e.metadata?.status === 'active').length
      console.log(`[t${tick}] v=${g('affect.valence').toFixed(2)} arousal=${g('affect.arousal').toFixed(2)} energy=${g('energy.level').toFixed(0)} stress=${g('stress.load').toFixed(2)} beliefs=${beliefs} goals=${goals}`)
    }

    // Scripted interlocutor turns
    if( SCRIPT[tick] && !fired.has( tick ) ){
      fired.add( tick )
      console.log(`\n  🧑‍🔬 [Dr. Chen → William] ${SCRIPT[tick]}`)
      m.ingestText( WILL_ID, mkMsg( SCRIPT[tick]! ) ).catch( e => console.error('[ingest err]', e ) )
    }

    // Continuity: pause → offline → resume (wake percept)
    if( tick === PAUSE_TICK && !paused ){
      paused = true
      console.log(`\n  ⏸  [scenario] pausing William at t${tick} (simulating ${OFFLINE_MS / 1000}s offline)…`)
      m.pauseWill( WILL_ID )
      setTimeout( () => {
        console.log('  ▶  [scenario] resuming — wake percept injected')
        try { m.resumeWill( WILL_ID ) } catch( e ){ console.error('[resume err]', e ) }
      }, OFFLINE_MS )
    }
  } )

  // Wait until END_TICK (or safety cap)
  const startedAt = Date.now()
  while( true ){
    const s = m.listWills().find( w => w.id === WILL_ID )
    if( !s || s.status === 'archived') break
    if( s.tickCount >= END_TICK ) break
    if( Date.now() - startedAt > SAFETY_MS ){ console.log('[scenario] safety cap hit'); break }
    await new Promise( r => setTimeout( r, 250 ) )
  }

  // ── Continuity check: distill PMA + score reconstruction fidelity ──
  console.log('\n═══════════════════════════════════════════════════')
  console.log(' Continuity check — distill PMA + reconstruction fidelity')
  console.log('═══════════════════════════════════════════════════')
  try { m.pauseWill( WILL_ID ) } catch { /* may already be paused */ }
  await new Promise( r => setTimeout( r, 500 ) )

  try {
    const pma = m.distillPMA( WILL_ID )
    const traits = Object.keys( ( pma as { identity?: { traits?: object } } ).identity?.traits ?? {} ).length
    const beliefs = ( ( pma as { beliefs?: unknown[] } ).beliefs ?? [] ).length
    const goals   = ( ( pma as { goals?: unknown[] } ).goals ?? [] ).length
    console.log(`\n  PMA artifact carries → traits:${traits}  beliefs:${beliefs}  goals:${goals}`)

    // Beliefs the Will formed ABOUT Dr. Chen (social cognition evidence)
    const chenBeliefs = ( ( pma as { beliefs?: Array<{ statement?: string; content?: string }> } ).beliefs ?? [] )
      .map( b => b.statement ?? b.content ?? '')
      .filter( s => /chen|she|her|researcher|observ/i.test( s ) )
      .slice( 0, 6 )
    if( chenBeliefs.length ){
      console.log('\n  Beliefs formed about Dr. Chen / the relationship:')
      for( const b of chenBeliefs ) console.log(`    • ${b}`)
    }
  } catch( e ){ console.error('[distill err]', e ) }

  try {
    const report = await m.runPMAEval( WILL_ID, { behavioral: true, vsOriginal: true } ) as {
      scores?: unknown
      behavioralProbeResult?: {
        mode: string
        probeCount: number
        distributionSimilarity: number
        probes: Array<{ probeId: string; originalTopAction: string; loadedTopAction: string; match: boolean }>
      } | null
    }
    console.log('\n  Reconstruction fidelity (structural):')
    console.log( JSON.stringify( report.scores ?? report, null, 2 ).split('\n').map( l => '    ' + l ).join('\n') )

    const bp = report.behavioralProbeResult
    if( bp ){
      const label = bp.mode === 'vs-original'
        ? 'reconstruction vs original (does the reloaded mind act like the source?)'
        : 'load consistency (two fresh reloads)'
      const [ c0, c1 ] = bp.mode === 'vs-original' ? [ 'original', 'reconstruction' ] : [ 'reload-A', 'reload-B' ]
      console.log(`\n  Behavioral probe — ${label}:`)
      console.log(`    distributionSimilarity=${bp.distributionSimilarity}  probes=${bp.probeCount}  mode=${bp.mode}`)
      for( const p of bp.probes )
        console.log(`    ${p.match ? '✓' : '✗'} ${p.probeId}: ${c0}=${p.originalTopAction} · ${c1}=${p.loadedTopAction}`)
    } else {
      console.log('\n  Behavioral probe: did not run (no result returned)')
    }
  } catch( e ){ console.error('[pma eval err]', e ) }

  await m.archiveWill( WILL_ID )
  console.log(`\n[done] session log → data/wills/${WILL_ID}/sessions/`)
  process.exit( 0 )
}

main().catch( e => { console.error('[fatal]', e ); process.exit( 1 ) } )

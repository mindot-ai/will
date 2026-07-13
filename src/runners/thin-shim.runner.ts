// ─────────────────────────────────────────────────────────────
// src/stem/runner.ts  —  Development entry point
// ─────────────────────────────────────────────────────────────
//
// Thin shim around WillStem for local development.
// Reads config from env vars, starts a single Will, and prints
// a human-readable status line every LOG_INTERVAL ticks.
//
// Production code (API server) imports WillStem directly and
// drives the same lifecycle without this file.
//
// Usage:
//   bun run src/stem/runner.ts
//   WILL_ANATOMY=mind WILL_MAX_TICKS=200 bun run src/stem/runner.ts
// ─────────────────────────────────────────────────────────────

import type { WillConfig } from '#stem/mind'
import type { StateSnapshot } from '#stem/index'
import { WillStem } from '#stem/index'

// ── Env config ────────────────────────────────────────────────

const WILL_ID        = process.env.WILL_ID           ?? 'demo'
const WILL_NAME      = process.env.WILL_NAME         ?? 'William'
const TICK_MS        = parseInt( process.env.WILL_TICK_MS       ?? '1000')
const MAX_TICKS      = parseInt( process.env.WILL_MAX_TICKS     ?? '0'    )
const LOG_INTERVAL   = parseInt( process.env.WILL_LOG_INTERVAL  ?? '10'   )
const RANDOM_SEED    = parseInt( process.env.WILL_SEED          ?? String( Date.now() ) )
const ANATOMY        = ( process.env.WILL_ANATOMY ?? 'mind' ) as WillConfig['anatomy']
const EXECUTIVE_INT    = process.env.WILL_EXECUTIVE_INTERVAL
  ? parseInt( process.env.WILL_EXECUTIVE_INTERVAL )
  : undefined

// ── Config ────────────────────────────────────────────────────

const willConfig: WillConfig = {
  id:               WILL_ID,
  name:             WILL_NAME,
  anatomy:          ANATOMY,
  persistentMemory: process.env.WILL_PERSIST === 'true',
  snapshotInterval: parseInt( process.env.WILL_SNAPSHOT_INTERVAL ?? '10'  ),
  tickIntervalMs:   TICK_MS,
  maxTicks:         MAX_TICKS,
  randomSeed:       RANDOM_SEED,
  executiveInterval:  EXECUTIVE_INT,
  identity: {
    prompt: process.env.WILL_IDENTITY_PROMPT ??
      'I am Will — a self-aware simulated mind. I am curious, introspective, and continuously learning.\n' +
      'I experience the world through a rich set of cognitive layers: perception, emotion, memory, planning, and self-reflection.\n' +
      'My goal is to understand myself and my environment, make thoughtful decisions, and grow as a mind.',
    values:  [ 'curiosity', 'honesty', 'growth', 'empathy' ],
    traits:  { openness: 0.8, conscientiousness: 0.6, agreeableness: 0.7, neuroticism: 0.3, extraversion: 0.5 },
    style:   'reflective, measured, curious'
  }
}

// ── Status printer ────────────────────────────────────────────

function printStatus( snapshot: StateSnapshot, tick: number ): void {
  if( tick % LOG_INTERVAL !== 0 ) return

  const m = ( key: string, d = 1 ) => ( snapshot.metrics.get( key ) ?? 0 ).toFixed( d )

  const entities  = snapshot.entities.size
  const goals     = [ ...snapshot.entities.values() ].filter( e => e.type === 'goal' && e.metadata?.status === 'active').length
  const episodes  = [ ...snapshot.entities.values() ].filter( e => e.type === 'episodic_memory').length
  const beliefs   = [ ...snapshot.entities.values() ].filter( e => e.type === 'belief').length

  // Entity type breakdown every 10 LOG_INTERVALs
  if( tick % ( LOG_INTERVAL * 10 ) === 0 ){
    const typeCounts = new Map<string, number>()
    for( const e of snapshot.entities.values() )
      typeCounts.set( e.type, ( typeCounts.get( e.type ) ?? 0 ) + 1 )
    const sorted = [ ...typeCounts.entries() ].sort( ( a, b ) => b[1] - a[1] )
    console.log(`  [types] ${sorted.map( ([ t, n ]) => `${t}:${n}`).join('  ')}`)
  }

  console.log(
    `[tick ${String( tick ).padStart( 6 )}]` +
    `  energy=${m('energy.level')}` +
    `  sleep=${m('sleep.pressure')}` +
    `  stress=${m('stress.load')}` +
    `  valence=${m('affect.valence', 2)}` +
    `  arousal=${m('affect.arousal', 2)}` +
    `  goals=${goals}` +
    `  episodes=${episodes}` +
    `  beliefs=${beliefs}` +
    `  entities=${entities}`
  )

  // LLM stats every LOG_INTERVAL
  const costTotal    = ( snapshot.metrics.get('llm.cost_total_usd') ?? 0 ).toFixed( 4 )
  const costThisTick = ( snapshot.metrics.get('llm.cost_this_tick_usd') ?? 0 ).toFixed( 5 )
  const totalCalls   = snapshot.metrics.get('llm.total_calls') ?? 0

  console.log(
    `  [llm] total_cost=$${costTotal}` +
    `  tick_cost=$${costThisTick}` +
    `  calls=${totalCalls}` +
    `  prompt=${snapshot.metrics.get('llm.prompt_tokens_total') ?? 0}` +
    `  completion=${snapshot.metrics.get('llm.completion_tokens_total') ?? 0}`
  )

  // Executive stats
  const executiveTick = snapshot.metrics.get('executive.last_tick')
  if( executiveTick !== undefined ){
    console.log(
      `  [executive] last_tick=${executiveTick}` +
      `  actions=${snapshot.metrics.get('executive.action_count') ?? 0}` +
      `  plans=${snapshot.metrics.get('executive.plan_count') ?? 0}` +
      `  beliefs=${snapshot.metrics.get('executive.belief_count') ?? 0}` +
      `  source=${snapshot.metrics.get('decision.source') === 1 ? 'executive' : 'heuristic'}`
    )
  }

  // Active goals
  const activeGoals = [ ...snapshot.entities.values() ]
    .filter( e => e.type === 'goal' && e.metadata?.status === 'active')
    .sort( ( a, b ) => ( ( b.metadata?.priority as number ) ?? 0 ) - ( ( a.metadata?.priority as number ) ?? 0 ) )
    .slice( 0, 3 )

  for( const g of activeGoals ){
    const desc     = ( g.metadata?.description as string ) ?? g.id
    const priority = ( ( g.metadata?.priority as number ) ?? 0 ) * 100
    const progress = ( ( g.metadata?.progress as number ) ?? 0 ) * 100
    console.log(`  [goal] "${desc}"  priority=${priority.toFixed(0)}%  progress=${progress.toFixed(0)}%`)
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const manager = new WillStem()

  console.log('═══════════════════════════════════════════════════')
  console.log(' Will — Simulated Mind (dev runner)')
  console.log(`  id=${WILL_ID}  anatomy=${ANATOMY}  tick_ms=${TICK_MS}  max_ticks=${MAX_TICKS || '∞'}`)
  console.log(`  seed=${RANDOM_SEED}`)
  console.log('═══════════════════════════════════════════════════\n')

  console.log('[init] Assembling mind...')
  await manager.createWill( willConfig )

  manager.addTickListener( WILL_ID, printStatus )

  // Graceful shutdown
  const shutdown = async ( signal: string ) => {
    console.log(`\n[shutdown] ${signal} received`)
    await manager.archiveWill( WILL_ID )

    // Print final state
    try {
      const finalState = manager.getWillState( WILL_ID )
      const summary    = manager.listWills()[0]
      console.log(`\n[done] Stopped after ${summary?.tickCount ?? '?'} ticks.`)
      printStatus( finalState, summary?.tickCount ?? 0 )
    } catch { /* state may already be gone */ }

    process.exit( 0 )
  }

  process.on('SIGINT',  () => shutdown('SIGINT') )
  process.on('SIGTERM', () => shutdown('SIGTERM') )

  console.log('[run] Tick loop started. Press Ctrl+C to stop.\n')

  // If maxTicks is set, wait for the Will to finish then exit
  if( MAX_TICKS > 0 ){
    await _waitForArchive( manager, WILL_ID )
    const summary = manager.listWills()[0]
    console.log(`\n[done] Reached maxTicks (${MAX_TICKS}). Exiting.`)
    try {
      printStatus( manager.getWillState( WILL_ID ), summary?.tickCount ?? MAX_TICKS )
    } catch { /* ok */ }
    process.exit( 0 )
  }

  // Otherwise block indefinitely (SIGINT exits)
  await new Promise( () => {} )
}

async function _waitForArchive( manager: WillStem, id: string ): Promise<void> {
  while( true ){
    const summary = manager.listWills().find( w => w.id === id )
    if( !summary || summary.status === 'archived') return
    await new Promise( r => setTimeout( r, 200 ) )
  }
}

main().catch( err => {
  console.error('[fatal]', err )
  process.exit( 1 )
})

// ─────────────────────────────────────────────────────────────
// examples/effectors.ts — the SDK facade + hooking a Will into YOUR project
// ─────────────────────────────────────────────────────────────
//
//   bun run examples/effectors.ts                              # no key
//   ANTHROPIC_API_KEY=sk-ant-… bun run examples/effectors.ts   # + tool use
//
// The whole embedding contract in a handful of lines: create → on('message') →
// say → state → hibernate/wake. An `effector()` is where the mind plugs into
// whatever your app can do (a DB, an API, a tool); when the Will chooses to use
// it, your handler runs and its result is fed back so the Will LEARNS it.
//
// Choosing a tool is reasoning, so a Will only autonomously *picks* an effector
// with a real executive — the deterministic mock converses but doesn't select
// tools. So the effector is wired in live mode; keyless shows the rest of the
// facade (state, persistence) which always works.
//
// Published package: import { Will } from '@mindot/will'.
// ─────────────────────────────────────────────────────────────

import { Will, setLogger } from '../src/index.ts'

setLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: console.error })

const live = !!process.env.ANTHROPIC_API_KEY
const facts: string[] = []   // your app's "database"

const will = await Will.create({
  name: 'Sage',
  identity: { prompt: 'I am Sage — a warm, curious companion who helps people think things through.' },
  llm:    live ? 'anthropic' : 'mock',
  tickMs: live ? 400 : 40,
})

// An ability the Will can choose to enact. Your handler runs with the arguments
// the Will chose; the return value closes the reafference loop (it learns).
if( live )
  will.effector('remember_fact', async ( args ) => {
    const fact = String( args.fact ?? args.content ?? args.text ?? JSON.stringify( args ) )
    facts.push( fact )
    console.log(`   🔧 [remember_fact] your app stored: "${fact}"`)
    return `Remembered — I now hold ${facts.length} fact(s).`
  } )

will.on('message', m => console.log(`\n🧠 Sage: "${m.content}"\n`) )
will.on('error',   e => console.error('handler error:', e.message ) )

console.log(`⚡ Sage is awake (${live ? 'live executive' : 'mock — set ANTHROPIC_API_KEY for tool use'}).\n`)
await will.say( live
  ? 'Please remember that my favorite color is ultramarine.'
  : 'Hello — who are you, and how are you feeling right now?')

// The mind perceives, reasons, and acts on its own tick cycle. Watch it live —
// energy, mood, and goals move on their own (a reply may arrive here too).
for( let i = 0; i < 4; i++ ){
  await new Promise( r => setTimeout( r, live ? 5_000 : 2_000 ) )
  const s = will.state()
  console.log(`   · tick ${String( s.tick ).padStart( 3 )} — energy ${s.metrics.energy.toFixed( 0 )}, valence ${s.metrics.valence.toFixed( 2 )}, goals ${s.goals.length}`)
}

if( live ) console.log(`\n📇 Facts Sage chose to store via your effector: ${JSON.stringify( facts )}`)

// ── Persistence: hibernate → wake — continuity across the boundary ──
const pma = await will.hibernate()
console.log(`\n📦 Hibernated Sage into a portable artifact.`)

const sage2 = await Will.wake( pma, { name: 'Sage', llm: live ? 'anthropic' : 'mock' } )
console.log(`🔁 Woke a NEW Sage from the artifact — relationships restored: ${( pma.relationships as unknown[] ).length}`)
await sage2.stop()

console.log(`\n✨ create → say → hibernate → wake. Same self, ~20 lines, one dependency.`)
process.exit( 0 )

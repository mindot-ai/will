// ─────────────────────────────────────────────────────────────
// examples/hello-will.ts — boot a mind in ~60 seconds, no API key
// ─────────────────────────────────────────────────────────────
//
//   bun run examples/hello-will.ts
//
// Creates a Will with a deterministic mock executive (testMode) — zero cost,
// zero keys — ticks it, watches its internal state move, sends it a message,
// and prints the reply. For a real LLM executive, see with-anthropic.ts.
//
// When using the published package, import from '@mindot/will' instead.
// ─────────────────────────────────────────────────────────────

import { WillStem, setLogger } from '../src/index.ts'

// Quiet the engine's internal diagnostics for a clean demo (errors only).
// Remove this line to watch the mind think.
setLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: console.error })

const stem = new WillStem()

console.log('⚡ Assembling a mind…\n')

const willId = await stem.createWill({
  id:   'hello-will',
  name: 'Dot',
  identity: {
    prompt: 'I am Dot, a small curious mind meeting the world for the first time.',
    values: [ 'curiosity', 'honesty' ],
    traits: {},
    style:  'warm and direct',
  },
  engineTier:       'standard',   // full cognition with an LLM executive…
  testMode:         true,         // …mocked: deterministic canned responses, no API key
  modelTier:        'haiku',
  persistentMemory: false,
  snapshotInterval: 1000,
  tickIntervalMs:   100,          // fast ticks for the demo (production default: 1000)

  // Communication is opt-in: without these the Will can neither hear nor speak.
  allowedGenericEffectors: [ 'listen', 'talk', 'text' ],

  initialGoals: [
    { description: 'Get to know whoever I meet', priority: 0.7 },
  ],
})

// ── Watch the mind run ────────────────────────────────────────
// Every tick carries the full metric surface (energy, stress, sleep pressure,
// valence/arousal, attention, circadian — plus ~20 more affect/drive dials) AND
// the drained outbox: everything the Will chose to say this tick.

let resolveReply: ( content: string ) => void
const replyArrived = new Promise<string | null>( resolve => {
  resolveReply = resolve
  setTimeout( () => resolve( null ), 45_000 )   // give up after 45 s
})

const unsub = stem.addTickListener( willId, ( snapshot, tick, outboxMessages ) => {
  // Outbound messages are drained into each tick's snapshot — capture the reply
  // and ack delivery (closes the Will's reafference loop: it knows it was heard).
  for( const msg of outboxMessages ){
    resolveReply( msg.content )
    try { stem.confirmMessageDelivery( willId, msg.id, true ) } catch { /* ok */ }
  }

  if( tick % 10 !== 0 ) return   // print every 10th tick
  const m = snapshot.metrics
  console.log(
    `tick ${String( tick ).padStart( 3 )} · ` +
    `energy ${( m.get('energy.level') ?? 0 ).toFixed( 2 )} · ` +
    `stress ${( m.get('stress.load') ?? 0 ).toFixed( 2 )} · ` +
    `valence ${( m.get('affect.valence') ?? 0 ).toFixed( 2 )} · ` +
    `curiosity ${( m.get('emotion.curiosity') ?? m.get('curiosity') ?? 0 ).toFixed( 2 )}`
  )
})

console.log('👁  Watching the mind tick…\n')
await new Promise( r => setTimeout( r, 5_000 ) )

// ── Talk to it ────────────────────────────────────────────────

console.log('\n💬 You: "Hello! Who are you?"\n')

await stem.senseText( willId, {
  kind:        'text',
  entityId:    'visitor',
  threadId:    'hello-thread',
  content:     'Hello! Who are you?',
  speakerName: 'Visitor',
  provenance:  'exafferent',
})

const reply = await replyArrived
console.log( reply ? `🧠 Dot: "${reply}"` : '🧠 (no reply within 45 s — see docs)')

// ── Peek inside ───────────────────────────────────────────────

const cognition = stem.getWillCognition( willId )
const goals     = cognition.goalManager.getActiveGoals()
const beliefs   = cognition.semanticIntegrator.getBeliefs()

console.log(`\n🔍 Inside the mind: ${goals.length} active goal(s), ${beliefs.length} belief(s)`)
for( const g of goals.slice( 0, 3 ) ) console.log(`   goal: ${g.description}`)

unsub()
await stem.archiveWill( willId )
console.log('\n💤 Will archived. Same seed + same inputs = same mind — that\'s the point.')
process.exit( 0 )

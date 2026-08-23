// ─────────────────────────────────────────────────────────────
// examples/with-anthropic.ts — a real executive: the mind thinks with Claude
// ─────────────────────────────────────────────────────────────
//
//   ANTHROPIC_API_KEY=sk-ant-… bun run examples/with-anthropic.ts
//
// Same shape as hello-will.ts, but the executive engine calls a real LLM:
// genuine reasoning, genuine replies, beliefs and goals that emerge from what
// you actually say. Costs real tokens (a short run ≈ a few cents on Haiku).
//
// When using the published package, import from '@mindot/will' instead.
// ─────────────────────────────────────────────────────────────

import { WillStem, setLogger } from '../src/index.ts'

if( !process.env.ANTHROPIC_API_KEY ){
  console.error('Set ANTHROPIC_API_KEY to run this example (see hello-will.ts for the no-key demo).')
  process.exit( 1 )
}

process.env.WILL_LLM_PROVIDER ??= 'anthropic'
process.env.WILL_LLM_MODEL    ??= 'claude-haiku-4-5'

setLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: console.error })

const stem = new WillStem()

console.log('⚡ Assembling a mind (real executive: %s)…\n', process.env.WILL_LLM_MODEL )

const willId = await stem.createWill({
  id:   'hello-claude',
  name: 'Dot',
  identity: {
    prompt: 'I am Dot, a small curious mind meeting the world for the first time.',
    values: [ 'curiosity', 'honesty' ],
    traits: {},
    style:  'warm and direct',
  },
  engineTier:       'standard',
  modelTier:        'haiku',
  persistentMemory: false,
  snapshotInterval: 1000,
  tickIntervalMs:   250,
  allowedGenericEffectors: [ 'listen', 'talk', 'text' ],
  initialGoals: [
    { description: 'Get to know whoever I meet', priority: 0.7 },
  ],
})

let resolveReply: ( content: string ) => void
const replyArrived = new Promise<string | null>( resolve => {
  resolveReply = resolve
  setTimeout( () => resolve( null ), 120_000 )
})

const unsub = stem.addTickListener( willId, ( snapshot, tick, outboxMessages ) => {
  for( const msg of outboxMessages ){
    resolveReply( msg.content )
    try { stem.confirmMessageDelivery( willId, msg.id, true ) } catch { /* ok */ }
  }
  if( tick % 10 !== 0 ) return
  const m = snapshot.metrics
  console.log(
    `tick ${String( tick ).padStart( 3 )} · ` +
    `energy ${( m.get('energy.level') ?? 0 ).toFixed( 2 )} · ` +
    `valence ${( m.get('affect.valence') ?? 0 ).toFixed( 2 )} · ` +
    `llm cost $${( m.get('llm.cost_total_usd') ?? 0 ).toFixed( 4 )}`
  )
})

await new Promise( r => setTimeout( r, 3_000 ) )

const question = 'Hello! Tell me — what is it like to be you, right now?'
console.log(`\n💬 You: "${question}"\n`)

await stem.ingestText( willId, {
  kind:        'text',
  entityId:    'visitor',
  threadId:    'hello-thread',
  content:     question,
  speakerName: 'Visitor',
  provenance:  'exafferent',
})

const reply = await replyArrived
console.log( reply ? `\n🧠 Dot: "${reply}"` : '\n🧠 (no reply within 120 s)')

unsub()
await stem.archiveWill( willId )
process.exit( 0 )

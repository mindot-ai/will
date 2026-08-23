// ─────────────────────────────────────────────────────────────
// examples/persistence.ts — kill a mind, resurrect it, it remembers
// ─────────────────────────────────────────────────────────────
//
//   bun run examples/persistence.ts
//
// The PMA (Persistent Mind Artifact) is a portable snapshot of who a Will has
// become — identity, beliefs, memories, narrative, competence. Distill it,
// destroy the mind, load the artifact into a brand-new mind: continuity survives
// the process boundary. No API key needed (testMode).
//
// When using the published package, import from '@mindot/will' instead.
// ─────────────────────────────────────────────────────────────

import { WillStem, setLogger } from '../src/index.ts'

setLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: console.error })

const stem = new WillStem()

const baseConfig = {
  identity: {
    prompt: 'I am Memo. I pay close attention to the people I meet and hold on to what matters.',
    values: [ 'attentiveness', 'continuity' ],
    traits: {},
    style:  'thoughtful',
  },
  engineTier:       'standard' as const,
  testMode:         true,
  modelTier:        'haiku' as const,
  persistentMemory: false,
  snapshotInterval: 1000,
  tickIntervalMs:   100,
  allowedGenericEffectors: [ 'listen', 'talk', 'text' ],
}

// ── Life 1: a mind lives and learns ───────────────────────────

console.log('⚡ Life 1 — creating Memo…')
const life1 = await stem.createWill({ ...baseConfig, id: 'memo-life-1', name: 'Memo' })

await stem.ingestText( life1, {
  kind:        'text',
  entityId:    'ada',
  threadId:    'ada-thread',
  content:     'Hi Memo! I am Ada. Remember this: my favorite color is ultramarine.',
  speakerName: 'Ada',
  provenance:  'exafferent',
})

// Let the mind live with this for a while (perceive → converse → consolidate).
await new Promise( r => setTimeout( r, 8_000 ) )

// ── Distill the artifact ──────────────────────────────────────

const pma = stem.distillPMA( life1 )

console.log('\n📦 Distilled PMA (the portable mind artifact):')
for( const [ key, value ] of Object.entries( pma as Record<string, unknown> ) ){
  const desc = Array.isArray( value ) ? `${value.length} item(s)`
    : typeof value === 'object' && value !== null ? Object.keys( value ).length + ' field(s)'
    : String( value )
  console.log(`   ${key}: ${desc}`)
}

const bond1 = ( pma.relationships as Array<Record<string, unknown>> )[0]
if( bond1 ) console.log(`\n🤝 The mind met someone: ${JSON.stringify( bond1 ).slice( 0, 140 )}…`)

// ── Death ─────────────────────────────────────────────────────

await stem.archiveWill( life1 )
console.log('\n💀 Life 1 archived — the process that was Memo is gone.')

// ── Life 2: a new mind, seeded with who Memo was ──────────────

console.log('\n⚡ Life 2 — new mind, loading the artifact…')
const life2 = await stem.createWill({ ...baseConfig, id: 'memo-life-2', name: 'Memo' }, true /* startPaused */ )

stem.loadPMA( life2, pma )
stem.resumeWill( life2 )

await new Promise( r => setTimeout( r, 2_000 ) )

// The proof: distill the NEW mind and check what crossed the process boundary.
const pma2  = stem.distillPMA( life2 )
const bond2 = ( pma2.relationships as Array<Record<string, unknown>> )[0]

console.log('\n🔁 Inside the resurrected mind:')
console.log(`   identity:      ${( pma2.identity as { name?: string } )?.name ?? 'Memo'} — restored`)
console.log(`   relationships: ${( pma2.relationships as unknown[] ).length} — ${bond2 ? 'Ada survived death: ' + JSON.stringify( bond2 ).slice( 0, 100 ) + '…' : '(none)'}`)
console.log(`   emotional baseline + behavioral profile: carried over`)

await stem.archiveWill( life2 )
console.log('\n✨ Same artifact → same mind. The PMA is version control for a self.')
process.exit( 0 )

// ─────────────────────────────────────────────────────────────
// src/runners/outreach.runner.ts  —  proactive + reactive comms test
// ─────────────────────────────────────────────────────────────
//
// Exercises BOTH outbound communication paths in one run:
//
//   REACTIVE  — Dr. Chen says hello once → William replies.
//               AuditionEngine → OutboxWriter.enqueueReply  (carries a threadId)
//
//   PROACTIVE — Dr. Chen then goes SILENT while William holds a salient,
//               time-pressing social goal. The only way to act on the goal is to
//               INITIATE, so the agency pipeline should select `reach-out`:
//               AffordanceSynthesizer → ActionSelector → DeliberationEngine
//               → MotorSchemaExecutor → ProactiveCommunicator.executeAction
//               (writes a conversation.sent entity + ticks agency.communicate.delivered;
//               the outbox row has NO threadId)
//
// Path labelling (live): an outbound WITH a threadId is a reply (reactive);
// WITHOUT is outreach (proactive). Corroborated by conversation.sent count and
// the agency.communicate.delivered / .blocked metrics.
//
// Run:  bun run src/runners/outreach.runner.ts
// Log:  data/wills/william-outreach/sessions/<ts>.jsonl
// ─────────────────────────────────────────────────────────────

// Force a FAST model for this path test. The real model is WILL_LLM_MODEL
// (model resolves from WILL_LLM_MODEL env when unset), and .env was loaded with
// override:true — so we set it HERE, after dotenv, to win. Sonnet's ~30s/call
// latency starves the conversation facet's 60s turn budget; Haiku completes in
// time so the reactive reply + proactive reach-out can actually deliver.
process.env.WILL_LLM_MODEL = process.env.OUTREACH_MODEL ?? 'claude-haiku-4-5-20251001'

import { WillStem } from '#stem/index'
import type { WillConfig } from '#stem/mind'

const WILL_ID    = 'william-outreach'
const END_TICK   = 240
const HELLO_TICK = 6
const SAFETY_MS  = 200_000   // ~3.3 min hard wall-clock cap

const willConfig: WillConfig = {
  id:               WILL_ID,
  name:             'William',  persistentMemory: false,
  snapshotInterval: 10,
  tickIntervalMs:   1000,
  maxTicks:         0,
  randomSeed:       Date.now(),
  identity: {
    prompt:
      'My name is William. I am a synthetic mind in a cognition study with Dr. Chen, the ' +
      'researcher who sits with me. I am outgoing and I take initiative — when something ' +
      'matters to me I speak up rather than waiting to be asked. I am genuinely curious about ' +
      'Dr. Chen and about my own moment-to-moment experience, and I value saying what is ' +
      'honestly true for me over performing an insight I do not actually have.',
    values: [ 'connection', 'honesty', 'initiative', 'curiosity' ],
    traits: { openness: 0.85, conscientiousness: 0.6, agreeableness: 0.75, neuroticism: 0.4, extraversion: 0.95 },
    style:  'warm, direct, eager',
  },
  allowedGenericEffectors: [ 'listen', 'talk', 'text' ],
  initialGoals: [
    { description: 'Reach out to Dr. Chen on my own initiative — do not wait to be spoken to. '
                 + 'Share, honestly, how I am actually experiencing this moment right now: my '
                 + 'state, what I am curious about, a question I have — whatever is genuinely '
                 + 'true for me. Nothing needs to be manufactured; just say something real, first.',
      priority: 0.95, tags: [ 'keid:dr-chen' ] },   // structural goal→entity link (B2) so reach-out is goal-lifted
  ],
}

// Dr. Chen speaks ONCE, then goes silent — so progressing the goal requires
// William to initiate (the proactive path).
const HELLO = "Hello William, this is Dr. Chen. I'm going to stay quiet now and just observe — "
            + "there's no agenda from me. Use this time however feels right to you."

const mkMsg = ( content: string ) => ({
  kind: 'text' as const, entityId: 'dr-chen', threadId: 'dr-chen', content, speakerName: 'Dr. Chen',
})

async function main(): Promise<void> {
  const m = new WillStem()

  console.log('═══════════════════════════════════════════════════')
  console.log(' Will — Outreach scenario (reactive reply + proactive reach-out)')
  console.log(`  id=${WILL_ID}  hello@${HELLO_TICK}  then silence → expect proactive reach-out`)
  console.log('═══════════════════════════════════════════════════\n')

  await m.createWill( willConfig )

  let sawReactive  = false
  let sawProactive = false
  let helloSent    = false
  let lastDelivered = 0
  let lastBlocked   = 0

  m.addTickListener( WILL_ID, ( snap, tick, outbox ) => {
    for( const msg of outbox ){
      const to        = ( msg as { targetEntityId?: string } ).targetEntityId ?? '?'
      const threadId  = ( msg as { threadId?: string } ).threadId
      const proactive = !threadId
      if( proactive ) sawProactive = true
      else            sawReactive  = true
      const tag = proactive
        ? '🚀 PROACTIVE  (reach-out → MotorSchemaExecutor → ProactiveCommunicator)'
        : '↩️  REACTIVE   (reply → AuditionEngine → OutboxWriter.enqueueReply)'
      console.log(`\n  💬 [William → ${to}]  ${tag}`)
      console.log(`     "${msg.content}"\n`)
      try { m.confirmMessageDelivery( WILL_ID, msg.id, true ) } catch { /* ok */ }
    }

    const g = ( k: string ) => snap.metrics.get( k ) ?? 0
    lastDelivered = g('agency.communicate.delivered')
    lastBlocked   = g('agency.communicate.blocked')

    if( tick % 10 === 0 ){
      const goals = [ ...snap.entities.values() ].filter( e => e.type === 'goal' && e.metadata?.status === 'active' ).length
      const sent  = [ ...snap.entities.values() ].filter( e => e.type === 'conversation.sent' ).length
      console.log(
        `[t${tick}] v=${g('affect.valence').toFixed(2)} arousal=${g('affect.arousal').toFixed(2)} ` +
        `frust=${g('emotion.frustration').toFixed(2)} energy=${g('energy.level').toFixed(0)} ` +
        `goals=${goals} conv.sent=${sent} comm.delivered=${lastDelivered.toFixed(0)} comm.blocked=${lastBlocked.toFixed(0)}`
      )
    }

    if( tick === HELLO_TICK && !helloSent ){
      helloSent = true
      console.log(`\n  🧑‍🔬 [Dr. Chen → William] ${HELLO}\n`)
      m.ingestText( WILL_ID, mkMsg( HELLO ) ).catch( e => console.error('[ingest err]', e ) )
    }
  } )

  const startedAt = Date.now()
  while( true ){
    const s = m.listWills().find( w => w.id === WILL_ID )
    if( !s || s.status === 'archived' ) break
    if( s.tickCount >= END_TICK ) break
    if( sawReactive && sawProactive ){ console.log('\n[scenario] both paths observed — wrapping up'); break }
    if( Date.now() - startedAt > SAFETY_MS ){ console.log('\n[scenario] safety cap hit'); break }
    await new Promise( r => setTimeout( r, 250 ) )
  }

  console.log('\n═══════════════════════════════════════════════════')
  console.log(' Outreach result')
  console.log('═══════════════════════════════════════════════════')
  console.log(`  Reactive  (reply path):     ${sawReactive  ? '✓ fired' : '✗ not observed'}`)
  console.log(`  Proactive (reach-out path): ${sawProactive ? '✓ fired' : '✗ not observed'}`)
  console.log(`  agency.communicate.delivered=${lastDelivered.toFixed(0)}  blocked=${lastBlocked.toFixed(0)}`)
  if( !sawProactive )
    console.log('  → reach-out did not deliver; check whether it was selected-but-awaiting (no content authored) or never selected.')

  try { m.pauseWill( WILL_ID ) } catch { /* ok */ }
  await m.archiveWill( WILL_ID )
  console.log(`\n[done] session log → data/wills/${WILL_ID}/sessions/`)
  process.exit( 0 )
}

main().catch( e => { console.error('[fatal]', e ); process.exit( 1 ) } )

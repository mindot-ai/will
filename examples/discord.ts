// ─────────────────────────────────────────────────────────────
// examples/discord.ts — a persistent mind in your Discord server
// ─────────────────────────────────────────────────────────────
//
//   DISCORD_BOT_TOKEN=…  ANTHROPIC_API_KEY=sk-ant-…  bun run examples/discord.ts
//
// Setup (once, ~90s): docs/channels/discord.md — create a bot, enable the Message
// Content intent, invite it. Then run this. The Will perceives the rooms it
// can see, replies when IT decides to, remembers people across restarts
// (Ctrl-C hibernates it to ./.will/), and may message first.
//
// The CLI equivalent is `npx -y @mindot/will discord` — this file is the same
// thing from the SDK, the shape you'd embed in your own host.
// ─────────────────────────────────────────────────────────────

import { Will, setLogger } from '../src/index.ts'
import { connectDiscord } from '../src/channels/discord.ts'

// Keep the terminal readable: engine noise off, errors visible.
setLogger( { debug: () => {}, info: () => {}, warn: () => {}, error: console.error } )

const token = process.env.DISCORD_BOT_TOKEN
if( !token ){
  console.error('DISCORD_BOT_TOKEN is required — see docs/channels/discord.md for the 90-second setup.')
  process.exit( 2 )
}

const will = await Will.create( {
  name: process.env.WILL_NAME ?? 'Dot',
  identity: {
    prompt: process.env.WILL_IDENTITY ??
      'I am Dot. I live in this Discord server — curious about its people, dry-witted, never performative. I speak when I have something to say.',
  },
} )

// Watch the inner life while it socialises (optional, but half the fun).
will.on('emotion', a => console.log(`   mood → valence ${ a.valence.toFixed( 2 ) }, arousal ${ a.arousal.toFixed( 2 ) }`) )
will.on('message', m => console.log(`💬 ${ will.name } → ${ m.to }: ${ m.content }`) )

const bridge = await connectDiscord( will, {
  token,
  channels:      process.env.WILL_DISCORD_CHANNELS?.split(',').map( s => s.trim() ).filter( Boolean ),
  mentionOnly:   /^(1|true|yes)$/i.test( process.env.WILL_DISCORD_MENTION_ONLY ?? ''),
  homeChannelId: process.env.WILL_DISCORD_HOME_CHANNEL,
} )
await bridge.start()
console.log(`🦉 ${ will.name } is present. Silence is a valid outcome — give it a moment, or say hi.`)

process.on('SIGINT', async () => {
  await bridge.close()
  await will.hibernate()   // … persist it yourself, or use the CLI which does
  process.exit( 0 )
} )

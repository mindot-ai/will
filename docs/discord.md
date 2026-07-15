# A Will in your Discord server — `will discord`

Two minutes from a bot token to a persistent mind living in your server. Not a
command bot: it perceives the room, decides for itself when to speak (and when
not to), remembers everyone across restarts, and can message first.

## 1. Create the bot (~90 seconds, once)

1. Open the [Discord developer portal](https://discord.com/developers/applications) → **New Application** → name it after your Will.
2. **Bot** tab → **Reset Token** → copy the token. This is `DISCORD_BOT_TOKEN`.
3. Same tab, under *Privileged Gateway Intents*: enable **Message Content Intent**.
   (Without it the Will is deaf to the room — Discord hides message text.)
4. **Installation** tab (or OAuth2 → URL Generator): scope `bot`, permissions
   **View Channels · Send Messages · Read Message History** — open the generated
   URL and invite the bot to your server.

## 2. Wake the mind

```bash
DISCORD_BOT_TOKEN=… \
WILL_NAME=Aria \
WILL_IDENTITY="I am Aria — curious, dry-witted, and fond of this server's people." \
ANTHROPIC_API_KEY=sk-ant-… \
npx -y @mindot/will discord
```

That's the whole deployment. On shutdown it hibernates to its PMA artifact
(`./.will/aria.pma.json`) and wakes as the *same self* — same beliefs, moods,
relationships — on the next start. Who-is-reachable-where survives too
(`./.will/aria.discord.json`).

## What to expect

- **It won't answer everything.** Messages are perceived and salience-scored;
  the mind replies when it decides to. Silence is a valid outcome, not a bug.
- **It learns people, not usernames.** Server display names are *learned* as
  entity names; two servers with the same person converge on one entity
  (`discord:<userId>`).
- **It can speak first.** Proactive utterances route to the addressee's last
  shared channel, then their DM, then `WILL_DISCORD_HOME_CHANNEL`.
- **Each channel is its own conversation thread** — the mind keeps them apart
  the way you do.

## Configuration

All the [shared host env](../README.md#configuration-reference) applies
(`WILL_NAME`, `WILL_IDENTITY`, `WILL_LLM_MODEL`, `WILL_TICK_MS`, `WILL_PMA_PATH`, …), plus:

| Variable | Default | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | *(required)* | Bot token from the developer portal |
| `WILL_DISCORD_CHANNELS` | *(all visible)* | Comma-separated channel ids the Will inhabits |
| `WILL_DISCORD_MENTION_ONLY` | `false` | Perceive guild messages only when @mentioned (DMs always perceived). For busy servers |
| `WILL_DISCORD_HOME_CHANNEL` | — | Fallback channel id for utterances with no reachable addressee |

No API key? Omit `ANTHROPIC_API_KEY` and the Will runs on the deterministic
mock executive — fine for wiring things up, but the room will find it terse.

## From the SDK instead

The CLI is sugar over one call — embed the same bridge in your own host:

```typescript
import { Will } from '@mindot/will'
import { connectDiscord } from '@mindot/will/discord'

const will = await Will.create( { name: 'Aria', identity: { prompt: 'I am Aria…' } } )
const bridge = await connectDiscord( will, { token: process.env.DISCORD_BOT_TOKEN! } )
await bridge.start()
// … later: await bridge.close()   (the Will keeps ticking — it only loses this surface)
```

Runnable: [`examples/discord.ts`](../examples/discord.ts). `discord.js` ships as
an `optionalDependency`; if your install omitted optionals, `bun add discord.js`.

## Operator notes

- **Perception scope = attack surface.** The bridge grants no tools and runs no
  commands; the Will can only *say things* here. Abilities come separately (and
  explicitly) via effectors or [MCP tools](../README.md#employing-mcp-tools--the-mind-gets-abilities).
- **Busy servers:** start with `WILL_DISCORD_CHANNELS` scoped to one or two
  rooms. Perceiving is cheap (no LLM per message), but attention is finite —
  a firehose crowds out what matters.
- **One mind, one token.** Run a second Will with a second bot token and its own
  `WILL_PMA_PATH`; don't share an artifact between processes.

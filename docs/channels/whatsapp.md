# A Will on WhatsApp — `will whatsapp`

Two minutes from a QR scan to a persistent mind on WhatsApp. Not a command bot:
it perceives your chats, decides for itself when to speak (and when not to),
remembers everyone across restarts, and can message first.

> ## ⚠️ Read this before deploying
>
> This bridge speaks the **linked-device protocol** (via
> [Baileys](https://github.com/WhiskeySockets/Baileys)) — the Will pairs to a
> WhatsApp account the way WhatsApp Web does. **That is not a sanctioned bot
> API.** WhatsApp's terms don't permit automation on personal accounts, and
> accounts that do it **can be permanently banned** — rarely with warning,
> never with appeal worth the name.
>
> - **Use a spare number.** A prepaid SIM is a euro; your ten-year-old main
>   account is not.
> - Meta's sanctioned path is the **Business Cloud API**: business
>   verification, webhook hosting, app review — no 2-minute pairing, but
>   ToS-clean. The bridge's transport seam (`WaLikeSocket`) is where a Cloud
>   API client would slot in if you need that.
> - Discord has no such tension — if you just want a Will people can talk to,
>   [that guide](discord.md) is the risk-free one.

## 1. Pair the device (~2 minutes, once)

```bash
WILL_NAME=Aria \
WILL_IDENTITY="I am Aria — warm, brief, allergic to smalltalk theatre." \
ANTHROPIC_API_KEY=sk-ant-… \
npx -y @mindot/will whatsapp
```

A QR appears in the terminal. On the phone that owns the (spare) number:
**WhatsApp → Settings → Linked devices → Link a device** → scan. Credentials
persist in `./.will/aria.wa-auth/` — later runs reconnect without a QR.

That's the whole deployment. On shutdown the mind hibernates to its PMA
(`./.will/aria.pma.json`) and wakes as the same self; who-is-reachable-where
survives in `./.will/aria.whatsapp.json`.

## What to expect

- **It won't answer everything.** Messages are perceived and salience-scored;
  the mind replies when it decides to. Silence is a valid outcome, not a bug.
- **It learns people, not numbers.** Push names are *learned* as entity names;
  DMs and groups converge on one entity per person (`whatsapp:<number>`).
- **It can speak first.** Proactive utterances route to the addressee's last
  shared group, else their DM — which WhatsApp lets the bridge *derive from the
  number*, so a Will can reach out to someone it has heard about but never met.
- **Each chat is its own conversation thread** — group and DM stay apart the
  way they do in your head.
- **The account looks online while the Will runs.** It is a linked device;
  read receipts and presence behave accordingly.

## Configuration

All the [shared host env](../../README.md#configuration-reference) applies
(`WILL_NAME`, `WILL_IDENTITY`, `WILL_LLM_MODEL`, `WILL_TICK_MS`, `WILL_PMA_PATH`, …), plus:

| Variable | Default | Description |
|---|---|---|
| `WILL_WHATSAPP_CHATS` | *(all chats)* | Comma-separated chat jids the Will inhabits (groups `…@g.us`, DMs `…@s.whatsapp.net`) |
| `WILL_WHATSAPP_MENTION_ONLY` | `false` | Perceive group messages only when @mentioned (DMs always perceived). For busy groups |
| `WILL_WHATSAPP_HOME_CHAT` | — | Fallback chat jid for utterances with no reachable addressee |

No token env — the QR pairing *is* the credential. The executive runs on either
supported provider: `ANTHROPIC_API_KEY` for Claude, or `ZAI_API_KEY` for GLM-5.2.
No key at all runs the deterministic mock — fine for wiring, terse in company.

## From the SDK instead

```typescript
import { Will } from '@mindot/will'
import { connectWhatsApp } from '@mindot/will/whatsapp'

const will = await Will.create( { name: 'Aria', identity: { prompt: 'I am Aria…' } } )
const bridge = await connectWhatsApp( will, { authPath: '.will/aria.wa-auth' } )
await bridge.start()
// … later: await bridge.close()   (the Will keeps ticking — it only loses this surface)
```

`baileys` and `qrcode-terminal` ship as `optionalDependencies`; if your install
omitted optionals: `bun add baileys qrcode-terminal`.

## It paired but says nothing

Same discipline as [Discord's list](discord.md#it-joined-but-says-nothing) —
work down, in order:

| Symptom | Cause |
|---|---|
| Boot exits with `the executive's LLM refused a test call` | The mind can't reason — bad key, empty balance, unknown model. The preflight fails loudly so this never becomes silence |
| QR never appears | Stale credentials in `.will/<name>.wa-auth/` — delete the dir to re-pair |
| `WhatsApp unlinked this device (logged out)` | The phone removed the link (or WhatsApp did — see the warning above). Delete the auth dir, pair again |
| It never reacts to a group | `WILL_WHATSAPP_CHATS` excludes it, or `WILL_WHATSAPP_MENTION_ONLY` is on and nobody @mentioned it |
| Personality edits do nothing | It woke from its artifact; `WILL_IDENTITY` is ignored on wake (the boot log says so). Delete the PMA to be born fresh |
| It's addressed and still quiet | Possibly real thought. Check `state()` / `data/wills/<id>/debug/` before assuming a bug |

## Operator notes

- **Perception scope = attack surface.** The bridge grants no tools; the Will
  can only say things here. Abilities stay explicit (effectors / MCP).
- **Start scoped.** `WILL_WHATSAPP_CHATS` with one group and one DM is the sane
  first deployment — WhatsApp accounts see *everything*, and a firehose crowds
  out what matters. (It also keeps the automation footprint small; see warning.)
- **One mind, one number.** A second Will gets its own number, `WILL_PMA_PATH`,
  and auth dir — never share either between processes.

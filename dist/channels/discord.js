import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

// src/channels/roster.ts
var FLUSH_MS = 2e3;
var ChannelRoster = class {
  constructor(path) {
    this.path = path;
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        for (const e of Array.isArray(raw) ? raw : []) this.entries.set(e.entityId, e);
      } catch {
      }
    }
  }
  path;
  entries = /* @__PURE__ */ new Map();
  dirty = false;
  timer = null;
  /** Upsert what we just learned about an entity; schedules a throttled flush. */
  record(update) {
    const prev = this.entries.get(update.entityId);
    const next = {
      lastSeenAt: Date.now(),
      ...prev,
      ...Object.fromEntries(Object.entries(update).filter(([, v]) => v !== void 0))
    };
    this.entries.set(next.entityId, next);
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, FLUSH_MS);
      this.timer.unref?.();
    }
    return next;
  }
  resolve(entityId) {
    return this.entries.get(entityId);
  }
  all() {
    return [...this.entries.values()];
  }
  /** Write to disk now (no-op when clean). Called by bridges on close. */
  flush() {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.all(), null, 2));
      this.dirty = false;
    } catch {
    }
  }
};

// src/channels/types.ts
function chunkText(text, max) {
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > max * 0.5 ? cut : max;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// src/channels/discord.ts
var DISCORD_MESSAGE_LIMIT = 2e3;
async function connectDiscord(will, opts) {
  const log = opts.log ?? ((m) => console.error(`[will:discord] ${m}`));
  const roster = new ChannelRoster(opts.rosterPath ?? `.will/${will.id}.discord.json`);
  const allowed = opts.channels?.length ? new Set(opts.channels) : null;
  const client = opts.client ?? await createDiscordClient();
  let lastActiveChannelId = opts.homeChannelId ?? null;
  client.on("messageCreate", (message) => {
    void onMessage(message);
  });
  async function onMessage(message) {
    const self = client.user;
    if (!self || message.author.id === self.id || message.author.bot) return;
    const isDM = !message.guildId;
    if (!isDM && allowed && !allowed.has(message.channelId)) return;
    const addressed = isDM || (message.mentions?.has(self.id) ?? false);
    if (opts.mentionOnly && !addressed) return;
    const entityId = `discord:${message.author.id}`;
    const speaker = message.member?.displayName ?? message.author.displayName ?? message.author.username;
    roster.record({
      entityId,
      userId: message.author.id,
      ...speaker ? { displayName: speaker } : {},
      ...isDM ? { dmChannelId: message.channelId } : { lastChannelId: message.channelId }
    });
    if (!isDM) lastActiveChannelId = message.channelId;
    if (addressed) await message.channel.sendTyping?.().catch(() => {
    });
    const text = message.cleanContent || message.content;
    if (!text.trim()) return;
    await will.perceive({
      text,
      from: entityId,
      thread: `discord:${message.channelId}`,
      ...speaker ? { speaker } : {}
    });
  }
  let closed = false;
  will.on("message", (m) => {
    if (!closed) void deliver(m);
  });
  async function deliver(m) {
    const peer = m.to ? roster.resolve(m.to) : void 0;
    const chunks = chunkText(m.content, DISCORD_MESSAGE_LIMIT);
    const channelIds = [peer?.lastChannelId, peer?.dmChannelId, opts.homeChannelId ?? void 0, lastActiveChannelId ?? void 0];
    for (const id of channelIds) {
      if (!id) continue;
      try {
        const channel = await client.channels.fetch(id);
        if (!channel?.send) continue;
        for (const chunk of chunks) await channel.send(chunk);
        return;
      } catch {
      }
    }
    if (peer) {
      try {
        const user = await client.users.fetch(peer.userId);
        for (const chunk of chunks) await user.send(chunk);
        return;
      } catch {
      }
    }
    log(`no route for utterance to '${m.to}' \u2014 dropped (${m.content.length} chars)`);
  }
  const bridge = {
    kind: "discord",
    async start() {
      if (!client.user) {
        const ready = new Promise((resolve) => {
          client.once("clientReady", resolve);
          client.once("ready", resolve);
        });
        await client.login(opts.token ?? "");
        await ready;
      }
      log(`${will.name} is present on Discord as user ${client.user?.id}`);
    },
    async close() {
      if (closed) return;
      closed = true;
      roster.flush();
      await Promise.resolve(client.destroy()).catch(() => {
      });
    }
  };
  return bridge;
}
async function createDiscordClient() {
  let mod;
  try {
    mod = await import('discord.js');
  } catch {
    throw new Error("discord.js is not installed (it is an optionalDependency) \u2014 run `bun add discord.js` / `npm i discord.js` and retry.");
  }
  const { Client, GatewayIntentBits, Partials } = mod;
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
    // DMs arrive on uncached channels
  });
}

export { connectDiscord };
//# sourceMappingURL=discord.js.map
//# sourceMappingURL=discord.js.map
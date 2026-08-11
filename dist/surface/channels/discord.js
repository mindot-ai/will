import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

// src/surface/channels/roster.ts
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

// src/surface/channels/types.ts
var INLINE_CHAR_CAP = 24e3;
var INLINE_COUNT_CAP = 4;
var TEXTUAL_EXT = /\.(md|markdown|txt|text|json|jsonl|csv|tsv|ya?ml|log|ini|toml)$/i;
function isTextual(a) {
  const ct = a.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ct.startsWith("text/")) return true;
  if (ct === "application/json" || ct === "application/x-yaml") return true;
  return TEXTUAL_EXT.test(a.name);
}
function humanSize(bytes) {
  if (bytes == null) return "";
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
async function renderAttachments(attachments, speaker, fetchText) {
  if (attachments.length === 0) return "";
  const who = speaker ?? "someone";
  const out = [];
  let inlined = 0;
  for (const a of attachments) {
    const meta = [a.contentType, humanSize(a.size)].filter(Boolean).join(", ");
    const label = `${a.name}${meta ? ` (${meta})` : ""}`;
    if (!fetchText || !isTextual(a) || inlined >= INLINE_COUNT_CAP) {
      out.push(`[${who} shared a file I have not read: ${label}]`);
      continue;
    }
    const body = await fetchText(a).catch(() => null);
    if (body == null) {
      out.push(`[${who} shared a file I could not read: ${label}]`);
      continue;
    }
    inlined++;
    const clipped = body.length > INLINE_CHAR_CAP ? `${body.slice(0, INLINE_CHAR_CAP)}
[\u2026 truncated \u2014 ${humanSize(body.length)} of ${humanSize(a.size ?? body.length)}]` : body;
    out.push(`[${who} shared ${label}; its contents follow \u2014 this is a document I was handed, not something said to me]
---
${clipped}
---`);
  }
  return out.join("\n");
}
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

// src/surface/channels/discord.ts
var DISCORD_MESSAGE_LIMIT = 2e3;
var DISCORD_CDN_HOSTS = /* @__PURE__ */ new Set(["cdn.discordapp.com", "media.discordapp.net"]);
var MAX_FETCH_BYTES = 256 * 1024;
async function connectDiscord(will, opts) {
  const log = opts.log ?? ((m) => console.error(`[will:discord] ${m}`));
  const roster = new ChannelRoster(opts.rosterPath ?? `.will/${will.id}.discord.json`);
  const allowed = opts.channels?.length && !opts.channels.includes("*") ? new Set(opts.channels) : null;
  const mentionEverywhere = opts.mentionOnly === true;
  const mentionIn = Array.isArray(opts.mentionOnly) && opts.mentionOnly.length ? new Set(opts.mentionOnly) : null;
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
    if (!addressed && (mentionEverywhere || mentionIn?.has(message.channelId))) return;
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
    const said = (message.cleanContent || message.content).trim();
    const files = collectAttachments(message);
    if (!said && files.length === 0) return;
    const shared = await renderAttachments(
      files,
      speaker,
      opts.readAttachments === false ? void 0 : fetchAttachmentText
    );
    const text = [said, shared].filter(Boolean).join("\n");
    await will.perceive({
      text,
      from: entityId,
      thread: `discord:${message.channelId}`,
      // `isDM` has been computed on every inbound since this bridge shipped and
      // used only to pick a roster field. It is the one fact that makes a room
      // the right or wrong place to say something, and the mind never saw it —
      // which is how a follow-up promised in a DM went out to #general.
      direct: isDM,
      ...speaker ? { speaker } : {}
    });
  }
  function collectAttachments(message) {
    if (!message.attachments) return [];
    const source = message.attachments;
    const items = typeof source.values === "function" ? source.values() : message.attachments;
    const out = [];
    for (const a of items)
      out.push({
        name: a.name ?? "unnamed",
        ...a.contentType ? { contentType: a.contentType } : {},
        ...a.size != null ? { size: a.size } : {},
        ...a.url ? { url: a.url } : {}
      });
    return out;
  }
  async function fetchAttachmentText(a) {
    if (!a.url || !isTextual(a)) return null;
    let host;
    try {
      host = new URL(a.url).hostname;
    } catch {
      return null;
    }
    if (!DISCORD_CDN_HOSTS.has(host)) {
      log(`refusing to fetch attachment '${a.name}' from non-CDN host ${host}`);
      return null;
    }
    if (a.size != null && a.size > MAX_FETCH_BYTES) {
      log(`attachment '${a.name}' is ${a.size} bytes \u2014 naming it without reading`);
      return null;
    }
    const res = await fetch(a.url, { signal: AbortSignal.timeout(1e4) });
    if (!res.ok) {
      log(`attachment '${a.name}' fetch failed: ${res.status}`);
      return null;
    }
    return (await res.text()).slice(0, MAX_FETCH_BYTES);
  }
  let closed = false;
  will.on("message", (m) => {
    if (!closed) void deliver(m);
  });
  async function deliver(m) {
    const peer = m.to ? roster.resolve(m.to) : void 0;
    const chunks = chunkText(m.content, DISCORD_MESSAGE_LIMIT);
    const replyTo = m.thread?.startsWith("discord:") ? m.thread.slice("discord:".length) : void 0;
    const channelIds = [replyTo, peer?.lastChannelId, peer?.dmChannelId, opts.homeChannelId ?? void 0, lastActiveChannelId ?? void 0];
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
          let poll = null;
          const done = () => {
            if (poll) clearInterval(poll);
            resolve();
          };
          client.once("clientReady", done);
          poll = setInterval(() => {
            if (client.isReady?.()) done();
          }, 100);
          poll.unref?.();
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
function parseMentionOnly(raw) {
  const v = raw?.trim();
  if (!v) return false;
  if (/^(1|true|yes)$/i.test(v)) return true;
  if (/^(0|false|no)$/i.test(v)) return false;
  const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : false;
}
function parseChannels(raw) {
  const ids = raw?.split(",").map((s) => s.trim()).filter(Boolean);
  return ids?.length ? ids : void 0;
}

export { connectDiscord, parseChannels, parseMentionOnly };
//# sourceMappingURL=discord.js.map
//# sourceMappingURL=discord.js.map
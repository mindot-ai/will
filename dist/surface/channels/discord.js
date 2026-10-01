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
var ATTACHMENT_READ_CEILING = 20 * 1024 * 1024;
var TEXTUAL_EXT = /\.(md|markdown|txt|text|json|jsonl|csv|tsv|ya?ml|log|ini|toml)$/i;
function isTextual(a) {
  const ct = a.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ct.startsWith("text/")) return true;
  if (ct === "application/json" || ct === "application/x-yaml") return true;
  return TEXTUAL_EXT.test(a.name);
}
async function readAttachments(attachments, read) {
  const out = [];
  for (const a of attachments) {
    const base = { name: a.name, ...a.contentType ? { contentType: a.contentType } : {}, ...a.size != null ? { size: a.size } : {} };
    if (!read) {
      out.push({ ...base, unread: "reading shared files is turned off here" });
      continue;
    }
    const got = await read(a).catch((e) => ({ unread: `I could not fetch it (${e instanceof Error ? e.message : String(e)})` }));
    out.push({ ...base, ...got });
  }
  return out;
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
function roomLabel(message) {
  if (!message.guildId) return void 0;
  const own = message.channel?.name;
  if (!own) return void 0;
  const parent = message.channel?.parent?.name;
  const room = parent ? `#${parent} \u203A ${own}` : `#${own}`;
  const guild = message.guild?.name;
  return guild ? `${room} in ${guild}` : room;
}
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
  client.on("messageReactionAdd", (reaction, user) => {
    void onReaction(reaction, user);
  });
  async function onReaction(reaction, user) {
    const self = client.user;
    if (!self || user.id === self.id || user.bot) return;
    const full = reaction.partial && reaction.fetch ? await reaction.fetch().catch(() => null) : reaction;
    if (!full) return;
    const msg = full.message.partial && full.message.fetch ? await full.message.fetch().catch(() => null) : full.message;
    if (!msg?.author) return;
    if (msg.author.id !== self.id) return;
    const isDM = !msg.guildId;
    if (!isDM && allowed && !allowed.has(msg.channelId)) return;
    const emoji = full.emoji?.name ?? (full.emoji?.id ? ":custom:" : "");
    if (!emoji) return;
    const who = user.displayName ?? user.username;
    const said = (msg.cleanContent || msg.content || "").trim();
    const text = said ? `[${who ?? "someone"} reacted ${emoji} to what I said: "${said}"]` : `[${who ?? "someone"} reacted ${emoji} to something I said]`;
    await will.sense({
      text,
      from: `discord:${user.id}`,
      thread: `discord:${msg.channelId}`,
      direct: isDM,
      // Exafferent, and the near-miss is worth naming: this is ABOUT something
      // she did, but it is not her doing it. Somebody else reacted. Reafference
      // is the mind sensing its OWN act's consequence, not the world's response
      // to that act — a reply would fail the same test for the same reason.
      provenance: "exafferent",
      ...roomLabel(msg) ? { threadName: roomLabel(msg) } : {},
      ...who ? { speaker: who } : {}
    });
  }
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
    const shared = await readAttachments(files, opts.readAttachments === false ? void 0 : readAttachment);
    await will.sense({
      text: said,
      ...shared.length > 0 ? { attachments: shared } : {},
      from: entityId,
      thread: `discord:${message.channelId}`,
      // `isDM` has been computed on every inbound since this bridge shipped and
      // used only to pick a roster field. It is the one fact that makes a room
      // the right or wrong place to say something, and the mind never saw it —
      // which is how a follow-up promised in a DM went out to #general.
      direct: isDM,
      // Somebody spoke. The bridge already drops her own messages (`onMessage`
      // returns early on `author.id === self.id`), so nothing reafferent can
      // reach this line today — but that filter is a bridge-level deletion of
      // a signal she is entitled to sense, not a reason for the field to lie.
      provenance: "exafferent",
      ...roomLabel(message) ? { threadName: roomLabel(message) } : {},
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
  async function readAttachment(a) {
    if (!isTextual(a)) return { unread: "not something I can read as text" };
    if (!a.url) return { unread: "Discord gave no way to fetch it" };
    let host;
    try {
      host = new URL(a.url).hostname;
    } catch {
      return { unread: "its address is not one I can read" };
    }
    if (!DISCORD_CDN_HOSTS.has(host)) {
      log(`refusing to fetch attachment '${a.name}' from non-CDN host ${host}`);
      return { unread: `it is not on Discord's own servers (${host}), and I only read files from there` };
    }
    const tooLarge = { unread: `it is larger than the ${ATTACHMENT_READ_CEILING / 1024 / 1024} MB I read` };
    if (a.size != null && a.size > ATTACHMENT_READ_CEILING) {
      log(`attachment '${a.name}' is ${a.size} bytes \u2014 naming it without reading`);
      return tooLarge;
    }
    const res = await fetch(a.url, { signal: AbortSignal.timeout(3e4) });
    if (!res.ok) {
      log(`attachment '${a.name}' fetch failed: ${res.status}`);
      return { unread: `I could not fetch it (HTTP ${res.status})` };
    }
    const text = await res.text();
    return new TextEncoder().encode(text).length > ATTACHMENT_READ_CEILING ? tooLarge : { text };
  }
  will.effector("inspect", async (_args, ctx) => {
    const address = (ctx.targetAddresses ?? []).find((a) => a.startsWith("discord:"));
    if (!address) return { success: false, description: "Not something I can see on Discord." };
    const id = address.slice("discord:".length);
    const channel = await client.channels.fetch(id).catch(() => null);
    if (!channel?.name) return { success: false, description: "There is nothing here I can look up." };
    const facts = [];
    if (channel.topic) facts.push(`it is for: ${channel.topic}`);
    if (channel.parent?.name) facts.push(`it sits under #${channel.parent.name}`);
    if (typeof channel.memberCount === "number")
      facts.push(`${channel.memberCount} people are in it`);
    if (facts.length === 0)
      return { success: false, description: `#${channel.name} has nothing recorded about it.` };
    const label = roomLabel({ guildId: "g", channel }) ?? `#${channel.name}`;
    return {
      success: true,
      description: `Looked into ${label}.`,
      // The room as Discord has it, in the shape Discord has it. Not flattened
      // into a sentence for the mind's benefit — a host that reshapes its own
      // data is deciding what the mind may notice about it, and `observation`
      // takes whatever shape the answer already had.
      //
      // `summary` is the one concession: it is what the executive prompt renders,
      // so the host says it in words rather than leaving the mind to read JSON.
      // Everything beside it stays available.
      observation: {
        summary: `I looked into ${label}: ${facts.join("; ")}.`,
        room: label,
        address,
        ...channel.topic ? { topic: channel.topic } : {},
        ...channel.parent?.name ? { parent: `#${channel.parent.name}` } : {},
        ...typeof channel.memberCount === "number" ? { memberCount: channel.memberCount } : {}
      }
    };
  });
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
      GatewayIntentBits.DirectMessages,
      // Neither is privileged, so this costs nothing to ask for — and without
      // them an emoji answer never arrives and reads as being ignored.
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions
    ],
    partials: [
      Partials.Channel,
      // DMs arrive on uncached channels
      // A reaction on a message this process did not cache — i.e. anything said
      // before the last restart — is delivered partial, and without these the
      // event is dropped before the handler sees it. That is precisely the
      // long-running conversation the answered loop exists for.
      Partials.Message,
      Partials.Reaction
    ]
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
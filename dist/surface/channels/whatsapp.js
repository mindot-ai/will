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

// src/surface/channels/whatsapp.ts
var WHATSAPP_MESSAGE_LIMIT = 65536;
var isGroupJid = (jid) => jid.endsWith("@g.us");
var bareId = (jid) => jid.split("@")[0].split(":")[0];
var dmJidFor = (userId) => `${userId}@s.whatsapp.net`;
function textOf(m) {
  const msg = m.message;
  return msg?.conversation ?? msg?.extendedTextMessage?.text ?? msg?.imageMessage?.caption ?? msg?.videoMessage?.caption ?? "";
}
async function connectWhatsApp(will, opts = {}) {
  const log = opts.log ?? ((m) => console.error(`[will:whatsapp] ${m}`));
  const roster = new ChannelRoster(opts.rosterPath ?? `.will/${will.id}.whatsapp.json`);
  const allowed = opts.chats?.length ? new Set(opts.chats) : null;
  let closed = false;
  const socket = opts.socket ?? await createWhatsAppSocket({
    authPath: opts.authPath ?? `.will/${will.id}.wa-auth`,
    log,
    stillOpen: () => !closed
  });
  let lastActiveChatId = opts.homeChatId ?? null;
  socket.ev.on("messages.upsert", ({ messages, type }) => {
    if (type && type !== "notify") return;
    for (const m of messages) void onMessage(m);
  });
  async function onMessage(m) {
    const jid = m.key.remoteJid;
    if (!jid || m.key.fromMe || !m.message || m.messageStubType) return;
    if (jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return;
    if (allowed && !allowed.has(jid)) return;
    const isGroup = isGroupJid(jid);
    const senderJid = isGroup ? m.key.participant : jid;
    if (!senderJid) return;
    const selfId = socket.user ? bareId(socket.user.id) : null;
    const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
    const addressed = !isGroup || selfId != null && mentioned.some((j) => bareId(j) === selfId);
    if (opts.mentionOnly && !addressed) return;
    const userId = bareId(senderJid);
    const entityId = `whatsapp:${userId}`;
    const speaker = m.pushName ?? void 0;
    roster.record({
      entityId,
      userId,
      ...speaker ? { displayName: speaker } : {},
      ...isGroup ? { lastChannelId: jid } : { dmChannelId: jid }
    });
    if (isGroup) lastActiveChatId = jid;
    if (addressed) await socket.sendPresenceUpdate?.("composing", jid).catch(() => {
    });
    const text = textOf(m);
    if (!text.trim()) return;
    await will.sense({
      // Somebody messaged her. Baileys filters `fromMe` upstream, so as with
      // Discord nothing reafferent reaches this bridge today.
      provenance: "exafferent",
      text,
      from: entityId,
      thread: `whatsapp:${jid}`,
      // A WhatsApp group jid ends in `@g.us`; anything else is a one-to-one chat.
      direct: !jid.endsWith("@g.us"),
      ...speaker ? { speaker } : {}
    });
  }
  will.on("message", (m) => {
    if (!closed) void deliver(m);
  });
  async function deliver(m) {
    const peer = m.to ? roster.resolve(m.to) : void 0;
    const chunks = chunkText(m.content, WHATSAPP_MESSAGE_LIMIT);
    const replyTo = m.thread?.startsWith("whatsapp:") ? m.thread.slice("whatsapp:".length) : void 0;
    const derivedDm = m.to?.startsWith("whatsapp:") ? dmJidFor(m.to.slice("whatsapp:".length)) : void 0;
    const targets = [replyTo, peer?.lastChannelId, peer?.dmChannelId, derivedDm, opts.homeChatId ?? void 0, lastActiveChatId ?? void 0];
    for (const jid of targets) {
      if (!jid) continue;
      try {
        for (const chunk of chunks) await socket.sendMessage(jid, { text: chunk });
        return;
      } catch {
      }
    }
    log(`no route for utterance to '${m.to}' \u2014 dropped (${m.content.length} chars)`);
  }
  return {
    kind: "whatsapp",
    async start() {
      log(`${will.name} is present on WhatsApp${socket.user ? ` as ${bareId(socket.user.id)}` : ""}`);
    },
    async close() {
      if (closed) return;
      closed = true;
      roster.flush();
      try {
        socket.end?.();
      } catch {
      }
    }
  };
}
async function createWhatsAppSocket(o) {
  let baileys;
  try {
    baileys = await import('baileys');
  } catch {
    throw new Error("baileys is not installed (it is an optionalDependency) \u2014 run `bun add baileys` / `npm i baileys` and retry.");
  }
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
  const noop = () => {
  };
  const logger = {
    level: "silent",
    child() {
      return logger;
    },
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop
  };
  const subscribers = [];
  let inner = null;
  const facade = {
    get user() {
      return inner?.user ? { id: inner.user.id, name: inner.user.name ?? void 0 } : null;
    },
    ev: { on: (_e, fn) => {
      subscribers.push(fn);
    } },
    sendMessage: (jid, content) => {
      if (!inner) return Promise.reject(new Error("whatsapp socket not connected"));
      return inner.sendMessage(jid, content);
    },
    sendPresenceUpdate: (state2, jid) => inner?.sendPresenceUpdate(state2, jid) ?? Promise.resolve(),
    end: () => inner?.end(void 0)
  };
  const { state, saveCreds } = await useMultiFileAuthState(o.authPath);
  await new Promise((resolveOpen, rejectOpen) => {
    let opened = false;
    function connect() {
      const sock = makeWASocket({ auth: state, logger });
      inner = sock;
      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("messages.upsert", (u) => {
        for (const fn of subscribers) fn(u);
      });
      sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) void printQr(qr, o.log);
        if (connection === "open" && !opened) {
          opened = true;
          resolveOpen();
        }
        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            const err = new Error("WhatsApp unlinked this device (logged out) \u2014 delete the auth dir and pair again.");
            o.log(err.message);
            if (!opened) rejectOpen(err);
            return;
          }
          if (o.stillOpen()) {
            o.log(`connection closed (status ${code ?? "?"}) \u2014 reconnecting\u2026`);
            setTimeout(connect, 3e3);
          }
        }
      });
    }
    connect();
  });
  return facade;
}
async function printQr(qr, log) {
  log("pair this device: WhatsApp \u2192 Settings \u2192 Linked devices \u2192 Link a device");
  try {
    const qrt = await import('qrcode-terminal');
    (qrt.default ?? qrt).generate(qr, { small: true });
  } catch {
    log(`qrcode-terminal not installed \u2014 raw pairing code:
${qr}`);
  }
}

export { connectWhatsApp };
//# sourceMappingURL=whatsapp.js.map
//# sourceMappingURL=whatsapp.js.map
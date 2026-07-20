import { cy as Will } from '../will-BFutuWb_.js';
import { C as ChannelBridge } from '../types-E9-HV-SW.js';

interface WaLikeMessage {
    key: {
        remoteJid?: string | null;
        fromMe?: boolean | null;
        /** Sender jid inside a group (absent in DMs). */
        participant?: string | null;
    };
    /** Sender's display ("push") name. */
    pushName?: string | null;
    messageStubType?: number | null;
    message?: {
        conversation?: string | null;
        extendedTextMessage?: {
            text?: string | null;
            contextInfo?: {
                mentionedJid?: string[] | null;
            } | null;
        } | null;
        imageMessage?: {
            caption?: string | null;
        } | null;
        videoMessage?: {
            caption?: string | null;
        } | null;
    } | null;
}
interface WaLikeSocket {
    /** The paired account, once connected. id like '4915…:12@s.whatsapp.net'. */
    user?: {
        id: string;
        name?: string;
    } | null;
    ev: {
        on(event: 'messages.upsert', fn: (u: {
            messages: WaLikeMessage[];
            type?: string;
        }) => void): unknown;
    };
    sendMessage(jid: string, content: {
        text: string;
    }): Promise<unknown>;
    sendPresenceUpdate?(state: 'composing' | 'paused', jid?: string): Promise<unknown>;
    /** Tear the connection down (does not unlink the device). */
    end?(err?: Error): void;
}
interface WhatsAppBridgeOptions {
    /** Chat jids the Will inhabits (groups `…@g.us`, DMs `…@s.whatsapp.net`). Unset = every chat. */
    chats?: string[];
    /** Perceive group messages only when the Will is @mentioned (DMs always perceived). */
    mentionOnly?: boolean;
    /** Fallback chat jid for utterances with no reachable addressee. */
    homeChatId?: string;
    /** Linked-device credentials dir (default: ./.will/<willId>.wa-auth). QR pairs on first run. */
    authPath?: string;
    /** Roster path (default: ./.will/<willId>.whatsapp.json). */
    rosterPath?: string;
    /** Test / power-user seam: bring your own socket; Baileys is never imported. */
    socket?: WaLikeSocket;
    log?: (msg: string) => void;
}
/**
 * Connect a Will to WhatsApp over the linked-device protocol. First run prints
 * a QR to pair (Settings → Linked devices → Link a device); credentials persist
 * in `authPath` so later runs reconnect silently. Close via the returned
 * `ChannelBridge.close()` — the Will keeps ticking; it only loses this surface.
 */
declare function connectWhatsApp(will: Will, opts?: WhatsAppBridgeOptions): Promise<ChannelBridge>;

export { type WaLikeMessage, type WaLikeSocket, type WhatsAppBridgeOptions, connectWhatsApp };

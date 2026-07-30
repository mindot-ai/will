import { cN as Will } from '../will-DaCvLgdp.js';
import { C as ChannelBridge } from '../types-E9-HV-SW.js';

interface DiscordLikeChannel {
    send(content: string): Promise<unknown>;
    sendTyping?(): Promise<unknown>;
}
interface DiscordLikeAttachment {
    name?: string | null;
    contentType?: string | null;
    size?: number;
    url?: string;
}
interface DiscordLikeMessage {
    content: string;
    cleanContent?: string;
    channelId: string;
    guildId?: string | null;
    author: {
        id: string;
        bot?: boolean;
        username?: string;
        displayName?: string;
    };
    member?: {
        displayName?: string;
    } | null;
    mentions?: {
        has(userId: string): boolean;
    };
    channel: DiscordLikeChannel;
    /**
     * Files riding with the message.
     *
     * discord.js hands us a `Collection`, which extends `Map` — so iterating it
     * directly yields `[id, attachment]` PAIRS, not attachments. Typing this as a
     * bare `Iterable` was wrong and silently produced `name: undefined` against
     * the real client while passing every test, because the test fake injects an
     * array. Both shapes are accepted now and normalised in `collectAttachments`.
     */
    attachments?: ReadonlyMap<string, DiscordLikeAttachment> | Iterable<DiscordLikeAttachment>;
}
interface DiscordLikeClient {
    user: {
        id: string;
        setPresence?(p: unknown): void;
    } | null;
    /** discord.js ≥14.22; polled so we needn't subscribe to the deprecated `ready`. */
    isReady?(): boolean;
    on(event: 'messageCreate', fn: (m: DiscordLikeMessage) => void): unknown;
    once(event: string, fn: () => void): unknown;
    login(token: string): Promise<unknown>;
    destroy(): Promise<unknown> | void;
    channels: {
        fetch(id: string): Promise<unknown>;
    };
    users: {
        fetch(id: string): Promise<{
            send(content: string): Promise<unknown>;
        }>;
    };
}
interface DiscordBridgeOptions {
    /** Bot token (Discord developer portal). Unused when `client` is injected pre-logged-in. */
    token?: string;
    /** Channel ids the Will inhabits. Unset = every channel it can see. */
    channels?: string[];
    /** Perceive guild messages only when the Will is @mentioned (DMs always perceived). */
    mentionOnly?: boolean;
    /** Fallback channel for utterances with no reachable addressee. */
    homeChannelId?: string;
    /** Roster path (default: ./.will/<willId>.discord.json). */
    rosterPath?: string;
    /**
     * Read the contents of text-like attachments (.md, .txt, .json, …) into the
     * percept, rather than only naming them. Default true.
     *
     * Only Discord's own CDN is ever fetched, and only up to a size cap. Set false
     * for a bridge that should never pull remote bytes — the Will still perceives
     * that a file arrived and can ask about it.
     */
    readAttachments?: boolean;
    /** Test / power-user seam: bring your own client; discord.js is never imported. */
    client?: DiscordLikeClient;
    log?: (msg: string) => void;
}
/**
 * Connect a Will to Discord. Resolves once the bridge is live (logged in and
 * relaying). Close it via the returned `ChannelBridge.close()` — the Will
 * itself is not stopped; it simply loses this surface.
 */
declare function connectDiscord(will: Will, opts: DiscordBridgeOptions): Promise<ChannelBridge>;

export { type DiscordBridgeOptions, type DiscordLikeAttachment, type DiscordLikeChannel, type DiscordLikeClient, type DiscordLikeMessage, connectDiscord };

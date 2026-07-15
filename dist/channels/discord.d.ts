import { cy as Will } from '../will-Dr2HbjeH.js';

/** A running connection between one Will and one platform. */
interface ChannelBridge {
    /** Platform kind, e.g. 'discord'. */
    readonly kind: string;
    /** Connect and start relaying. Resolves once the bridge is live. */
    start(): Promise<void>;
    /** Disconnect and release resources. Idempotent. */
    close(): Promise<void>;
}

interface DiscordLikeChannel {
    send(content: string): Promise<unknown>;
    sendTyping?(): Promise<unknown>;
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

export { type DiscordBridgeOptions, type DiscordLikeChannel, type DiscordLikeClient, type DiscordLikeMessage, connectDiscord };

/** A running connection between one Will and one platform. */
interface ChannelBridge {
    /** Platform kind, e.g. 'discord'. */
    readonly kind: string;
    /** Connect and start relaying. Resolves once the bridge is live. */
    start(): Promise<void>;
    /** Disconnect and release resources. Idempotent. */
    close(): Promise<void>;
}

export type { ChannelBridge as C };

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { a6 as EffectorHandler, cN as Will } from '../will-DzkAPP2z.js';

/** Where the tools live: spawn a local server, reach a remote one, or bring a connected client. */
type McpToolsSource = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
} | {
    url: string;
} | {
    client: Client;
};
interface McpEffectorsOptions {
    /** Intrinsic effort prior 0..1 seeded on every bridged ability (default 0.2). */
    cost?: number;
    /** Prefix for the ability names (e.g. 'fs_') — avoids collisions across servers. */
    prefix?: string;
}
/** Minimal structural view of an MCP tool (the SDK's zod-inferred type, loosened). */
interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: {
        type?: string;
        properties?: Record<string, {
            type?: string;
            description?: string;
        }>;
        required?: string[];
    };
}
/**
 * The ability's *meaning*: the tool's description plus a compact hint of the
 * arguments it takes — so the executive knows what to supply in an action's
 * `args` when it enacts this ability.
 */
declare function describeMcpTool(tool: McpToolInfo): string;
/**
 * The effector handler for one bridged tool: checks required args (an ability
 * enacted without its needed articulation fails informatively — reafference
 * learns from it), calls the tool, and maps the result onto EffectorResult.
 */
declare function buildMcpHandler(client: Client, tool: McpToolInfo): EffectorHandler;
/**
 * Register an MCP server's tools as the Will's abilities. Returns the ability
 * names registered and a `close()` for the connection (call it when the Will
 * stops; a client passed in via `source.client` is left open).
 */
declare function connectMcpEffectors(will: Will, source: McpToolsSource, opts?: McpEffectorsOptions): Promise<{
    names: string[];
    close: () => Promise<void>;
}>;

export { type McpEffectorsOptions, type McpToolInfo, type McpToolsSource, buildMcpHandler, connectMcpEffectors, describeMcpTool };

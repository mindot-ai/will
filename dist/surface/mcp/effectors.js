import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// src/surface/mcp/effectors.ts
var MEANING_CAP = 300;
function describeMcpTool(tool) {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const argHints = Object.entries(props).map(([key, p]) => `${key}${required.has(key) ? "" : "?"}${p.description ? `: ${p.description}` : ""}`);
  const base = (tool.description ?? `The ${tool.name} tool.`).trim().replace(/\s+/g, " ");
  const hint = argHints.length > 0 ? ` (args \u2014 ${argHints.join("; ")})` : "";
  const full = `${base}${hint}`;
  return full.length > MEANING_CAP ? `${full.slice(0, MEANING_CAP - 1)}\u2026` : full;
}
function buildMcpHandler(client, tool) {
  return async (args) => {
    const props = tool.inputSchema?.properties;
    const filtered = {};
    for (const [k, v] of Object.entries(args ?? {}))
      if (!props || k in props) filtered[k] = v;
    const missing = (tool.inputSchema?.required ?? []).filter(
      (k) => filtered[k] === void 0 || filtered[k] === ""
    );
    if (missing.length > 0)
      return {
        success: false,
        description: `${tool.name} needs ${missing.join(", ")} \u2014 enact it deliberately, supplying them in the action's args.`
      };
    try {
      const res = await client.callTool({ name: tool.name, arguments: filtered });
      const text = (res.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n").trim() || (res.isError ? "The tool reported an error." : "Done (no output).");
      return {
        success: !res.isError,
        description: res.isError ? `${tool.name} reported an error.` : `${tool.name} ran.`,
        // Whatever it said — including what it said when it failed. An error
        // message is information about the world too, and cutting it or folding
        // it into the fate is how a mind ends up knowing that something went
        // wrong without ever learning what.
        observation: text
      };
    } catch (err) {
      return { success: false, description: `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}
async function connect(source) {
  if ("client" in source) return { client: source.client, owned: false };
  const client = new Client({ name: "mindot-will", version: "0" });
  if ("url" in source)
    await client.connect(new StreamableHTTPClientTransport(new URL(source.url)));
  else
    await client.connect(new StdioClientTransport({
      command: source.command,
      ...source.args ? { args: source.args } : {},
      // Merge over the SDK's safe default env so PATH etc. survive a custom env.
      env: { ...getDefaultEnvironment(), ...source.env ?? {} }
    }));
  return { client, owned: true };
}
async function connectMcpEffectors(will, source, opts = {}) {
  const { client, owned } = await connect(source);
  const { tools } = await client.listTools();
  const names = [];
  for (const tool of tools) {
    const name = `${opts.prefix ?? ""}${tool.name}`;
    will.effector(name, {
      description: describeMcpTool(tool),
      cost: opts.cost ?? 0.2,
      tags: ["mcp"],
      handler: buildMcpHandler(client, tool)
    });
    names.push(name);
  }
  return { names, close: async () => {
    if (owned) await client.close();
  } };
}

export { buildMcpHandler, connectMcpEffectors, describeMcpTool };
//# sourceMappingURL=effectors.js.map
//# sourceMappingURL=effectors.js.map
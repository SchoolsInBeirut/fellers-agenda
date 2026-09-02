// mcp-client.mjs - a minimal JSON-RPC-over-stdio MCP client.
//
// Enough of the protocol to be useful and nothing more: spawn the server, do
// the `initialize` handshake, call tools, parse the text content block back
// into JSON. There is no SDK dependency because this repo has no runtime
// dependencies, and because the surface that is actually needed is this small.
//
// The server is the CALLER'S choice, not this file's. A connector reads its
// entry out of `.mcp.json` (or builds one from config) and passes
// `{ command, args, env }` in. That is what lets one client serve a Brightspace
// server on Windows (`cmd /c npx ...`), a Canvas server on a Mac (`uvx ...`)
// and a recorded fake in a test, without any of them knowing about each other.
//
// Usage:
//   const c = await connect({ command: "npx", args: ["-y", "some-mcp-server"] });
//   const courses = await c.call("get_my_courses", {});
//   c.close();
import { spawn } from "node:child_process";

/** Long, because an interactive SSO handshake happens inside a single call. */
export const CALL_TIMEOUT_MS = 120000;

export class McpError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpError";
  }
}

/**
 * Connect to an MCP server over stdio.
 *
 * @param {{command: string, args?: string[], env?: object, cwd?: string,
 *          timeoutMs?: number, clientName?: string}} server
 */
export async function connect(server) {
  if (!server || typeof server.command !== "string" || !server.command) {
    throw new McpError("mcp: connect() needs a { command, args } server descriptor");
  }
  const timeoutMs = Number(server.timeoutMs) > 0 ? Number(server.timeoutMs) : CALL_TIMEOUT_MS;
  const child = spawn(server.command, server.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: server.cwd ?? process.cwd(),
    env: server.env ? { ...process.env, ...server.env } : process.env,
  });

  const pending = new Map();
  let nextId = 1;
  let buf = "";
  let stderrTail = "";

  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });

  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers write plenty of non-JSON to stdout; ignore it
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new McpError(`RPC error: ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    }
  });

  child.on("error", (e) => {
    for (const [, p] of pending) p.reject(new McpError(`could not start ${server.command}: ${e.message}`));
    pending.clear();
  });

  child.on("exit", (code) => {
    for (const [, p] of pending) p.reject(new McpError(`server exited (code ${code}). stderr: ${stderrTail}`));
    pending.clear();
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpError(`timeout on ${method}. stderr: ${stderrTail}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: server.clientName ?? "agenda", version: "1.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  return {
    /** Call a tool; returns the parsed JSON payload from the text content block. */
    async call(name, args = {}) {
      const result = await request("tools/call", { name, arguments: args });
      if (result?.isError) {
        const text = result.content?.[0]?.text ?? "unknown tool error";
        throw new McpError(`tool ${name} failed: ${text}`);
      }
      const text = result?.content?.[0]?.text ?? "";
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    /** The tool names this server advertises - used by the doctor. */
    async listTools() {
      const result = await request("tools/list", {});
      return (result?.tools ?? []).map((t) => t.name);
    },
    close() {
      child.kill();
    },
    get stderrTail() {
      return stderrTail;
    },
  };
}

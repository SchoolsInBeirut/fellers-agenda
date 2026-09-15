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
// CLOSING IT IS NOT `child.kill()`
//
// On Windows a server started as `cmd /c npx -y some-server` is a chain of four
// processes: cmd -> npx -> cmd -> node. `child.kill()` ends the first one, the
// other three keep the stdio pipes they inherited open, and node will not exit
// while a pipe is open - so the scrape finishes, prints its summary, and then
// hangs forever with nothing to say. That is the single failure that made runs
// sit at 100% until a timeout killed them. `close()` therefore runs
// `taskkill /T /F` on the whole tree first, then kills the child, then destroys
// the pipes and unrefs. It is idempotent and it never throws: a close that
// raises during cleanup would mask whatever the caller was already handling.
//
// Usage:
//   const c = await connect({ command: "npx", args: ["-y", "some-mcp-server"] });
//   const courses = await c.call("get_my_courses", {});
//   c.close();
import { spawn, spawnSync } from "node:child_process";

/** Long, because an interactive SSO handshake happens inside a single call. */
export const CALL_TIMEOUT_MS = 120000;

export class McpError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpError";
  }
}

/**
 * The argv for a whole-tree kill, or null where taskkill does not apply. PURE.
 *
 * Every other platform gets null rather than a `kill -TERM -<pgid>` equivalent:
 * a POSIX `spawn` without `detached` puts the child in this process's group, so
 * killing the group would kill the caller too, and the pipe-holding grandchild
 * problem is a Windows one in the first place.
 */
export function killTreeArgv(pid, platform = process.platform) {
  if (platform !== "win32") return null;
  // `Number(null)` is 0, so the type has to be checked before the value: a
  // `taskkill /PID null` would be a confusing no-op, and `/PID 0` is worse.
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  return ["taskkill", "/T", "/F", "/PID", String(pid)];
}

/**
 * An idempotent, never-throwing `close()` for a spawned child.
 *
 * `spawnSyncImpl` and `platform` are injected so the tree-kill can be exercised
 * against a fake child: no process, no npx, no network. Order matters - end
 * stdin so a well-behaved server can exit on its own, take the tree down, kill
 * what is left, and only then destroy the pipes we are still holding.
 */
export function makeCloser(child, { spawnSyncImpl = spawnSync, platform = process.platform } = {}) {
  let closed = false;
  return function close() {
    if (closed) return;
    closed = true;
    try { child.stdin.end(); } catch { /* already gone */ }
    const argv = killTreeArgv(child?.pid, platform);
    if (argv) {
      try { spawnSyncImpl(argv[0], argv.slice(1), { stdio: "ignore", timeout: 15000 }); } catch { /* best effort */ }
    }
    try { child.kill(); } catch { /* already dead */ }
    try { child.stdout.destroy(); } catch { /* already gone */ }
    try { child.stderr.destroy(); } catch { /* already gone */ }
    try { child.unref(); } catch { /* not unrefable */ }
  };
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
    close: makeCloser(child),
    get stderrTail() {
      return stderrTail;
    },
  };
}

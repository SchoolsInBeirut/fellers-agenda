// node --test  (run from the repository root)
//
// close() has to kill the whole Windows process tree an MCP server spawns
// (cmd -> npx -> cmd -> node), not just the top cmd.exe, or the grandchildren
// orphan and hold the inherited stdio pipes open forever - which is how a scrape
// finishes, prints its summary, and then hangs until something times it out.
//
// Real child_process.spawn is never touched here. makeCloser() takes an
// injectable spawnSyncImpl seam, so the tree-kill is exercised against a fake
// child with no process, no npx and no network anywhere in it.
import test from "node:test";
import assert from "node:assert/strict";
import { CALL_TIMEOUT_MS, McpError, connect, killTreeArgv, makeCloser } from "../src/lib/mcp-client.mjs";

// ------------------------------------------------------------------ killTreeArgv

test("killTreeArgv builds a taskkill /T /F /PID argv on win32", () => {
  assert.deepEqual(killTreeArgv(1234, "win32"), ["taskkill", "/T", "/F", "/PID", "1234"]);
});

test("killTreeArgv is null on every other platform", () => {
  assert.equal(killTreeArgv(1234, "linux"), null);
  assert.equal(killTreeArgv(1234, "darwin"), null);
});

test("killTreeArgv refuses a pid that is not a number rather than killing /PID undefined", () => {
  assert.equal(killTreeArgv(undefined, "win32"), null);
  assert.equal(killTreeArgv(null, "win32"), null);
  assert.equal(killTreeArgv("not-a-pid", "win32"), null);
});

// ------------------------------------------------------------------ makeCloser

function fakeChild() {
  return {
    pid: 42,
    killed: false,
    unrefed: false,
    stdin: { ended: false, end() { this.ended = true; } },
    stdout: { destroyed: false, destroy() { this.destroyed = true; } },
    stderr: { destroyed: false, destroy() { this.destroyed = true; } },
    kill() { this.killed = true; },
    unref() { this.unrefed = true; },
  };
}

test("close() on win32 takes the whole tree down, then kills, then releases the pipes", () => {
  const child = fakeChild();
  const seen = [];
  const spawnSyncImpl = (cmd, args) => {
    seen.push([cmd, ...args]);
    return { status: 0 };
  };
  const close = makeCloser(child, { spawnSyncImpl, platform: "win32" });

  close();

  assert.deepEqual(seen, [killTreeArgv(42, "win32")]);
  assert.equal(child.killed, true);
  assert.equal(child.stdin.ended, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.unrefed, true);
});

test("close() off win32 skips taskkill but still kills and cleans up", () => {
  const child = fakeChild();
  let calls = 0;
  const close = makeCloser(child, { spawnSyncImpl: () => { calls += 1; return { status: 0 }; }, platform: "linux" });

  close();

  assert.equal(calls, 0);
  assert.equal(child.killed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.unrefed, true);
});

test("close() is idempotent: three calls do the work once", () => {
  const child = fakeChild();
  let spawns = 0;
  let kills = 0;
  child.kill = () => { kills += 1; };
  const close = makeCloser(child, { spawnSyncImpl: () => { spawns += 1; return { status: 0 }; }, platform: "win32" });

  close();
  close();
  close();

  assert.equal(spawns, 1);
  assert.equal(kills, 1);
});

test("close() never throws when the taskkill itself explodes", () => {
  const child = fakeChild();
  const close = makeCloser(child, {
    spawnSyncImpl: () => { throw new Error("taskkill exploded"); },
    platform: "win32",
  });

  assert.doesNotThrow(() => close());
  // A failed tree kill must not stop the ordinary kill from being attempted.
  assert.equal(child.killed, true);
});

test("close() never throws when the child's own methods throw", () => {
  const child = fakeChild();
  child.kill = () => { throw new Error("ESRCH"); };
  child.stdin.end = () => { throw new Error("EPIPE"); };
  child.stdout.destroy = () => { throw new Error("boom"); };
  child.unref = () => { throw new Error("not unrefable"); };
  const close = makeCloser(child, { spawnSyncImpl: () => ({ status: 0 }), platform: "win32" });

  assert.doesNotThrow(() => close());
  // Everything after the first throw still ran.
  assert.equal(child.stderr.destroyed, true);
});

test("close() defaults are the real platform and spawnSync, and still never throw", () => {
  // No options at all: the defaults have to be usable, because connect() uses them.
  const child = fakeChild();
  child.pid = undefined;                 // no pid -> no tree kill on any platform
  assert.doesNotThrow(() => makeCloser(child)());
  assert.equal(child.killed, true);
});

// ------------------------------------------------------------------ the client itself

test("connect() still refuses a server descriptor with no command", async () => {
  await assert.rejects(() => connect(null), McpError);
  await assert.rejects(() => connect({}), McpError);
  await assert.rejects(() => connect({ command: "" }), McpError);
});

test("the call timeout is still a long one, because an SSO handshake happens inside a call", () => {
  assert.ok(CALL_TIMEOUT_MS >= 60000);
});

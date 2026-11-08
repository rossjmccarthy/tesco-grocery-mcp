// Offline test helpers: a fake Tesco GraphQL endpoint and a minimal MCP
// client that runs the built server over stdio. No network, no real account.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A JWT-shaped token that expires in an hour (only exp is ever read). */
export function fakeToken() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `Bearer ${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

/**
 * Fake xapi.tesco.com: handlers maps an operationName to a function of
 * (variables, state) returning that operation's `data`. Every operation is
 * recorded as { operationName, variables, headers }.
 */
export async function fakeTesco(handlers) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const ops = JSON.parse(body || "[]");
      const out = ops.map((op) => {
        calls.push({ operationName: op.operationName, variables: op.variables, headers: req.headers });
        const h = handlers[op.operationName];
        if (!h) return { errors: [{ message: `fake has no ${op.operationName}` }] };
        try {
          return { data: h(op.variables) };
        } catch (err) {
          return { errors: [{ message: err.message }] };
        }
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/`, calls, close: () => server.close() };
}

/** Start the built server with credentials in a temporary config dir. */
export async function mcpServer(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tesco-unit-"));
  const envPath = join(dir, ".env");
  await writeFile(envPath, `TESCO_BEARER_TOKEN=${fakeToken()}\nTESCO_CUSTOMER_UUID=uuid-1\n`);
  const proc = spawn("node", [join(ROOT, "dist/index.js")], {
    env: { ...process.env, TESCO_ENV_PATH: envPath, XDG_CONFIG_HOME: dir, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const strayStdout = [];
  let buf = "";
  let nextId = 1;
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        strayStdout.push(line);
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  proc.stderr.on("data", () => {});
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const ready = (async () => {
    await send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "unit", version: "1" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  })();
  return {
    dir,
    strayStdout,
    async initializeResult() {
      await ready;
      return (await send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "unit", version: "1" } })).result;
    },
    async listTools() {
      await ready;
      return (await send("tools/list", {})).result.tools;
    },
    /** Returns { ok, text, json } for a tool call. */
    async call(name, args = {}) {
      await ready;
      const msg = await send("tools/call", { name, arguments: args });
      if (msg.error) return { ok: false, text: msg.error.message };
      const text = msg.result.content?.[0]?.text ?? "";
      let json;
      try {
        json = JSON.parse(text);
      } catch {}
      return { ok: !msg.result.isError, text, json };
    },
    close: () => proc.kill(),
  };
}

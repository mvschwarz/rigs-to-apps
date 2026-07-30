// Authenticated board screenshot via Chrome DevTools Protocol (Node v22 global WebSocket).
// Injects the Kanboard KB_SID session cookie (from env, never logged), navigates to the
// board, and captures a full-page PNG. No third-party deps; no UI automation of the
// lifecycle (that ran over JSON-RPC) — this only RENDERS the already-real board for a receipt.
import fs from "node:fs";

const DEBUG = process.env.CDP_URL || "http://127.0.0.1:9333";
const BOARD = process.env.BOARD_URL;
const CK_NAME = process.env.CK_NAME, CK_VALUE = process.env.CK_VALUE;
const OUT = process.env.OUT;

const ver = await (await fetch(`${DEBUG}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0; const pending = new Map();
function send(method, params = {}, sessionId) {
  const mid = ++id;
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method) events.push(m);
};
const waitEvent = async (method, timeout = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { const i = events.findIndex((e) => e.method === method); if (i >= 0) return events.splice(i, 1)[0]; await new Promise((r) => setTimeout(r, 50)); }
  return null;
};

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Network.enable", {}, sessionId);
await send("Network.setCookie", { name: CK_NAME, value: CK_VALUE, domain: "127.0.0.1", path: "/", httpOnly: true }, sessionId);
await send("Page.enable", {}, sessionId);
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
await send("Page.navigate", { url: BOARD }, sessionId);
await waitEvent("Page.loadEventFired");
await new Promise((r) => setTimeout(r, 1200)); // settle
const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
fs.writeFileSync(OUT, Buffer.from(data, "base64"));
console.log("captured", OUT, fs.statSync(OUT).size, "bytes");
ws.close();
process.exit(0);

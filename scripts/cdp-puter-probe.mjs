// CDP Runtime.evaluate 로 WebView 내부의 Puter 상태를 관측한다.
// 사용법: node scripts/cdp-puter-probe.mjs
import WebSocket from "ws";

const targets = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) { console.error("FAIL: page target 없음"); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
ws.on("message", (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

function send(method, params) {
  return new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

const expr = `(async () => {
  const out = {};
  out.hasPuter = typeof window.puter !== "undefined";
  out.puterKeys = out.hasPuter ? Object.keys(window.puter) : null;
  out.hasTxt2img = !!window.puter?.ai?.txt2img;
  let signed = "unknown";
  try {
    const raw = window.puter?.auth?.isSignedIn?.();
    signed = (raw instanceof Promise) ? await raw : !!raw;
  } catch (e) { signed = "error:" + (e && e.message || String(e)); }
  out.signedIn = signed;
  out.ua = navigator.userAgent;
  out.href = location.href;
  return JSON.stringify(out, null, 1);
})()`;

const ev = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
console.log("=== Puter probe ===");
console.log(ev.result?.result?.value ?? JSON.stringify(ev.result ?? ev));

const eval2 = `(async () => {
  if (!window.puter?.ai?.txt2img) return "NO_TXT2IMG";
  try {
    const r = await window.puter.ai.txt2img("solid color background, plain teal");
    const t = Object.prototype.toString.call(r);
    let info = { type: t };
    if (r instanceof HTMLImageElement) info.src = (r.currentSrc || r.src || "").slice(0, 120);
    else if (typeof r === "string") info.value = r.slice(0, 120);
    else info.keys = r && typeof r === "object" ? Object.keys(r).slice(0, 8) : null;
    return "OK " + JSON.stringify(info);
  } catch (e) { return "ERR " + (e && (e.message || e.error?.message || e.error || String(e))); }
})()`;

const ev2 = await send("Runtime.evaluate", { expression: eval2, awaitPromise: true, returnByValue: true });
console.log("=== txt2img probe ===");
console.log(ev2.result?.result?.value ?? JSON.stringify(ev2.result ?? ev2));

ws.close();
process.exit(0);
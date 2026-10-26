// Puter 생성 UI 흐름 검증(실기동): CDP로 provider=puter 설정 → "Puter로 생성·적용" 클릭 →
// 콘솔/예외 수집 → 생성 정보(미리보기) 블록 텍스트 회수.
// 의존성: ws (package.json devDependencies에 명시됨)
import WebSocket from "ws";
import http from "http";

const LIST = "http://127.0.0.1:9222/json";
function getTargets() {
  return new Promise((res, rej) => {
    http.get(LIST, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res(JSON.parse(d)));
    }).on("error", rej);
  });
}
const evalIn = (ws, id, expr) =>
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));

const logs = [];
const exceptions = [];

const targets = await getTargets();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://localhost:1420"));
if (!page) { console.log("NO_PAGE_TARGET:", targets.map((t) => t.url).join(" | ")); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 10;
const pending = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.type + ": " + (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" "));
  if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "unknown");
  if (m.method === "Log.entryAdded") logs.push("log." + m.params.entry.level + ": " + m.params.entry.text);
});

await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
ws.send(JSON.stringify({ id: 2, method: "Log.enable" }));

// 1) provider select 를 puter 로 설정 (React 제어 컴포넌트)
{
  const id = ++msgId;
  evalIn(ws, id, `(() => {
    const sels = [...document.querySelectorAll("select")];
    const info = sels.map((s) => (s.id || "(noid)") + ":" + s.options.length + ":" + [...s.options].map((o) => o.value).join(",")).join(" || ");
    const sel = sels.find((s) => [...s.options].some((o) => o.value === "puter"));
    if (!sel) return "NO_PROVIDER_SELECT: " + info;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(sel, "puter");
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return "SET_OK " + (sel.id || "(noid)") + " now=" + sel.value;
  })()`);
  const rep = await new Promise((r) => pending.set(id, r));
  console.log("step1 setProvider:", JSON.stringify(rep.result?.result?.value ?? rep));
}

// 2) Puter 생성 버튼 클릭
{
  const id = ++msgId;
  evalIn(ws, id, `(() => {
    const btns = [...document.querySelectorAll("button")].map((b) => (b.id || "(noid)") + ":" + b.textContent.trim()).join(" || ");
    const btn = [...document.querySelectorAll("button")].find((b) => /Puter/.test(b.textContent) && /생성/.test(b.textContent));
    if (!btn) return "NO_BTN: " + btns;
    btn.click();
    return "CLICKED " + (btn.id || "(noid)") + ":" + btn.textContent.trim();
  })()`);
  const rep = await new Promise((r) => pending.set(id, r));
  console.log("step2 click:", JSON.stringify(rep.result?.result?.value ?? rep));
}

// 3) 60초 대기하며 콘솔 수집 → 상태 회수
await new Promise((r) => setTimeout(r, 60000));

{
  const id = ++msgId;
  evalIn(ws, id, `(() => {
    const pick = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : "(none)"; };
    return JSON.stringify({
      genInfoPreview: pick("genInfoPreview"),
      genInfo: pick("genInfo"),
      status: pick("statusText") || pick("appStatus"),
    });
  })()`);
  const rep = await new Promise((r) => pending.set(id, r));
  console.log("step3 ui-state:", JSON.stringify(rep.result?.result?.value ?? rep));
}

const id2 = ++msgId;
evalIn(ws, id2, "location.href");
const rep2 = await new Promise((r) => pending.set(id2, r));
console.log("href:", rep2.result?.result?.value);

console.log("=== console/exceptions ===");
for (const l of logs.slice(-40)) console.log(l);
for (const e of exceptions.slice(-10)) console.log("EXC:", e);

ws.close();
process.exit(exceptions.length ? 1 : 0);
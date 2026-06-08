/* ───────────────────────────────────────────────────────────
   회귀 테스트 — assets/app.js 를 최소 DOM/fetch 셰임 위에서 e2e 구동.
   의존성 0 (node 빌트인만). 실행: node tools/test_render.mjs

   목적: equity series 가 1개(첫 거래일)뿐일 때도 시황(브리핑) 패널이
         렌더링되는지 검증한다.
   배경 버그: series.length < 2 이면 computeMetrics 가 null 을 반환 →
             renderKPIs(null) 가 TypeError → main() 중단 →
             initBriefings() 미실행 → 시황 패널이 hidden 으로 남음.
   ─────────────────────────────────────────────────────────── */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ── 최소 DOM 셰임 ─────────────────────────────────────────── */
const NUMERIC = new Set([
  "scrollWidth", "clientWidth", "scrollLeft", "clientHeight",
  "scrollHeight", "offsetWidth", "offsetHeight",
]);

const registry = new Map();   // selector/id → 안정적 FakeEl

function makeEl() {
  const el = {
    hidden: false, innerHTML: "", textContent: "", value: "",
    style: new Proxy({ setProperty() {} }, { get: (t, p) => t[p] ?? "", set: (t, p, v) => (t[p] = v, true) }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    appendChild: (c) => c, append() {}, prepend() {}, cloneNode: () => proxyEl(),
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    focus() {}, blur() {}, remove() {},
    querySelector: () => proxyEl(), querySelectorAll: () => [],
  };
  el.content = el.content || null;
  return el;
}

function proxyEl() {
  const base = makeEl();
  base.content = proxyWrap(makeEl());   // <template>.content
  return proxyWrap(base);
}

function proxyWrap(base) {
  return new Proxy(base, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === "string" && NUMERIC.has(prop)) return 0;
      return () => undefined;   // 알 수 없는 속성/메서드는 안전한 no-op
    },
    set(t, prop, val) { t[prop] = val; return true; },
    has() { return true; },
  });
}

function pick(key) {
  if (!registry.has(key)) registry.set(key, proxyEl());
  return registry.get(key);
}

const documentShim = {
  documentElement: proxyEl(),
  querySelector: (sel) => pick(sel),
  querySelectorAll: () => [],
  getElementById: (id) => pick("#" + id),
  createElement: () => proxyEl(),
  createElementNS: () => proxyEl(),
};

class MutationObserverShim { observe() {} disconnect() {} }

/* ── fetch 셰임 — 로컬 data/ 파일을 읽어 응답 ──────────────── */
async function fetchShim(p) {
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  const text = fs.readFileSync(file, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
}

/* ── 샌드박스 구성 ─────────────────────────────────────────── */
let unhandled = null;
const sandbox = {
  document: documentShim,
  window: { innerWidth: 1200, innerHeight: 800, addEventListener() {} },
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  requestAnimationFrame: () => {},   // getTotalLength 등 비표시 경로 진입 방지
  MutationObserver: MutationObserverShim,
  fetch: fetchShim,
  console,
  setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;

process.on("unhandledRejection", (e) => { unhandled = e; });

/* ── app.js 로드 & main() 자동 실행 ───────────────────────── */
// 패널은 index.html 에서 hidden 으로 시작 — 셰임에도 동일하게 시드.
pick("#briefing-panel").hidden = true;

const appSrc = fs.readFileSync(path.join(ROOT, "assets/app.js"), "utf8");
vm.runInNewContext(appSrc, sandbox, { filename: "app.js" });

/* main() 과 initBriefings() 의 async 체인 완료 대기 */
await new Promise((r) => setTimeout(r, 200));

/* ── 검증 ─────────────────────────────────────────────────── */
let failed = 0;
const check = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`); }
  else { console.error(`  ✗ ${msg}`); failed++; }
};

console.log("회귀 테스트: 단일 equity 포인트에서 시황 렌더링");

const series = JSON.parse(fs.readFileSync(path.join(ROOT, "data/equity.json"), "utf8")).series || [];
console.log(`  (data/equity.json series 개수 = ${series.length})`);

check(unhandled === null,
  `main() 실행 중 미처리 예외 없음${unhandled ? " — " + unhandled : ""}`);

const panel = pick("#briefing-panel");
check(panel.hidden === false, "시황 패널(#briefing-panel) 이 표시됨 (hidden=false)");

const headline = pick("#briefing-headline");
check(typeof headline.textContent === "string" && headline.textContent.length > 0,
  "시황 헤드라인(one_liner) 이 채워짐");

const titleDate = pick("#briefing-title-date");
check(/시황 예상$/.test(titleDate.textContent || ""),
  `시황 제목이 설정됨 ("${titleDate.textContent}")`);

const kpis = pick("#kpis");
check((kpis.innerHTML || "").includes("총 자산"),
  "KPI 영역이 렌더링됨 (총 자산 포함)");

console.log(failed === 0 ? "\nPASS ✅" : `\nFAIL ❌ (${failed}건)`);
process.exit(failed === 0 ? 0 : 1);

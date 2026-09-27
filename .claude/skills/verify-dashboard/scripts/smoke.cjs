#!/usr/bin/env node
// 대시보드 렌더 스모크 테스트 — verify-dashboard 스킬의 결정적 신호원.
//
// 레포 루트를 정적 서버로 띄워 headless Chromium 으로 열고, 데스크톱·모바일
// 뷰포트에서 핵심 섹션이 실제로 그려졌는지·JS 에러가 없는지·가로 스크롤이
// 없는지 확인한 뒤 스크린샷을 남긴다. 실패 항목이 하나라도 있으면 exit 1.
//
// 실행 (레포 루트에서):
//   NODE_PATH="$(npm root -g)" node .claude/skills/verify-dashboard/scripts/smoke.cjs [출력디렉터리]
// 필요: playwright (npm i -g playwright && npx playwright install chromium)
// 브라우저 경로를 강제하려면 CHROMIUM_PATH=/path/to/chromium

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("playwright 를 찾을 수 없음 — `npm i -g playwright` 후 NODE_PATH=\"$(npm root -g)\" 로 실행");
  process.exit(2);
}

const ROOT = path.resolve(__dirname, "../../../..");
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), "gazua-smoke"));
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon",
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(ROOT, url.endsWith("/") ? url + "index.html" : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function launch() {
  const opts = { headless: true };
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  try {
    return await chromium.launch(opts);
  } catch (e) {
    // playwright 버전과 설치된 브라우저 빌드가 다를 때 (예: Claude Code 원격 환경)
    const fallback = "/opt/pw-browsers/chromium";
    if (!opts.executablePath && fs.existsSync(fallback)) {
      return chromium.launch({ ...opts, executablePath: fallback });
    }
    throw e;
  }
}

// 장중 스냅샷은 인덱스가 없어 앱이 최근 날짜 파일을 404 로 탐색한다 — 정상 동작.
const EXPECTED_404 = /\/data\/intraday\/\d{4}-\d{2}-\d{2}\.json$/;

async function check(browser, base, name, viewport) {
  const failures = [];
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => failures.push(`JS 예외: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
      failures.push(`console.error: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !EXPECTED_404.test(r.url()))
      failures.push(`HTTP ${r.status()}: ${r.url().replace(base, "")}`);
  });

  await page.goto(base + "/index.html", { waitUntil: "networkidle" });
  await page.waitForFunction(() => !document.querySelector("#loading"), null, { timeout: 15000 })
    .catch(() => failures.push("#loading 이 사라지지 않음 (렌더 미완료)"));

  const r = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const n = (s) => document.querySelectorAll(s).length;
    return {
      errorBox: q(".error-box")?.innerText.trim() || null,
      kpis: n("#kpis > *"),
      appText: q("#app")?.innerText || "",
      chart: n("#equity-chart svg path, #equity-chart svg polyline"),
      trades: n("#trades-body tr"),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  if (r.errorBox) failures.push(`error-box 표시: ${r.errorBox.slice(0, 120)}`);
  if (!r.kpis) failures.push("KPI 카드 없음 (#kpis 비어 있음)");
  const bad = r.appText.match(/.{0,30}\b(NaN|undefined|Infinity)\b.{0,30}/);
  if (bad) failures.push(`화면에 NaN/undefined/Infinity 노출: "${bad[0].replace(/\s+/g, " ").trim()}"`);
  if (!r.chart) failures.push("자산 추이 차트 SVG 경로 없음");
  if (!r.trades) failures.push("매매 테이블 행 없음");
  if (r.overflow > 1) failures.push(`가로 스크롤 발생 (${r.overflow}px 넘침)`);

  const shot = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  await page.close();
  return { name, failures, shot, stats: `kpis=${r.kpis} chartPaths=${r.chart} tradeRows=${r.trades}` };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch();
  let failed = false;
  try {
    for (const [name, vp] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
      const res = await check(browser, base, name, vp);
      failed ||= res.failures.length > 0;
      console.log(`${res.failures.length ? "FAIL" : "PASS"} ${name} (${res.stats}) → ${res.shot}`);
      for (const f of res.failures) console.log(`  - ${f}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});

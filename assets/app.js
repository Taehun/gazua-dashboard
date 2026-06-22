/* ═══════════════════════════════════════════════════════════
   가즈아 (GAZUA) 대시보드 — 의존성 0, 수제 SVG 차트
   data/*.json → KPI · 자산 추이(레짐 밴드) · 드로다운 · 월별 · 매매 테이블
   ═══════════════════════════════════════════════════════════ */
"use strict";

const REGIME_LABEL = {
  strong_bull: "강세 가속", bull: "강세", neutral: "중립",
  bear: "약세", crash: "급락", panic: "패닉", halt: "중단",
};
const REGIME_VAR = {
  strong_bull: "--rg-strong-bull", bull: "--rg-bull", neutral: "--rg-neutral",
  bear: "--rg-bear", crash: "--rg-crash", panic: "--rg-panic", halt: "--rg-halt",
};

const $ = (sel, el = document) => el.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const fmtPct = (x, digits = 1) =>
  (x >= 0 ? "+" : "") + (x * 100).toFixed(digits) + "%";
const fmtKRW = (x) => {
  const abs = Math.abs(x);
  if (abs >= 1e8) return (x / 1e8).toFixed(2) + "억";
  if (abs >= 1e4) return Math.round(x / 1e4).toLocaleString("ko-KR") + "만";
  return Math.round(x).toLocaleString("ko-KR");
};
const fmtNum = (x) => x.toLocaleString("ko-KR");
const fmtWonFull = (x) => (x < 0 ? "-" : "") + "₩" + Math.round(Math.abs(x)).toLocaleString("ko-KR");
const fmtSignWon = (x) => (x >= 0 ? "+" : "-") + fmtKRW(Math.abs(x));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ── 데이터 로드 ──────────────────────────────────────────── */
async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// 장중 스냅샷은 날짜별 파일 — 인덱스가 없으므로 오늘(KST)부터 최대 maxBack일
// 거슬러 올라가 가장 최근 파일을 찾는다(주말·휴장이면 직전 거래일 스냅샷 사용).
async function loadLatestIntraday(maxBack = 10) {
  const baseMs = Date.now() + 9 * 3600e3;
  for (let k = 0; k <= maxBack; k++) {
    const d = new Date(baseMs - k * 86400e3).toISOString().slice(0, 10);
    const snap = await fetchJSON(`data/intraday/${d}.json`).catch(() => null);
    if (snap) return snap;
  }
  return null;
}

async function loadAll() {
  const [meta, equity, tradesIdx, intraday] = await Promise.all([
    fetchJSON("data/meta.json"),
    fetchJSON("data/equity.json"),
    fetchJSON("data/trades/index.json"),
    loadLatestIntraday(),
  ]);
  const months = (tradesIdx.months || []).slice().sort().reverse();
  const monthFiles = await Promise.all(
    months.map((m) => fetchJSON(`data/trades/${m}.json`).catch(() => null))
  );
  const trades = monthFiles.filter(Boolean)
    .flatMap((f) => f.trades || [])
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return { meta, series: equity.series || [], months, trades, intraday };
}

/* ── 지표 계산 ───────────────────────────────────────────── */
function computeMetrics(series, initialCapital) {
  if (!series.length) return null;
  const first = series[0], last = series[series.length - 1];
  const base = initialCapital || first.value;
  const totalReturn = last.value / base - 1;
  const years = series.length / 252;
  const cagr = years > 0 ? Math.pow(last.value / base, 1 / years) - 1 : 0;

  const rets = [];
  for (let i = 1; i < series.length; i++)
    rets.push(series[i].value / series[i - 1].value - 1);
  // 첫 거래일처럼 일별 수익률 표본이 없으면(또는 1개면) 변동성 지표는 0 으로 둔다.
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1
    ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1))
    : 0;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  const vol = sd * Math.sqrt(252);   // 연환산 변동성
  const winRate = rets.length ? rets.filter((r) => r > 0).length / rets.length : 0;

  // 베타(β) — 벤치 대비 민감도. 같은 날 전략·벤치 일별 수익률이 둘 다
  // 존재하는 구간에서 cov(port,bench)/var(bench). 표본 부족 시 null.
  let beta = null;
  const pr = [], br = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i], b = series[i - 1];
    if (a.benchmark && b.benchmark) {
      pr.push(a.value / b.value - 1);
      br.push(a.benchmark / b.benchmark - 1);
    }
  }
  if (br.length >= 2) {
    const pm = pr.reduce((x, y) => x + y, 0) / pr.length;
    const bm = br.reduce((x, y) => x + y, 0) / br.length;
    let cov = 0, varb = 0;
    for (let i = 0; i < br.length; i++) { cov += (pr[i] - pm) * (br[i] - bm); varb += (br[i] - bm) ** 2; }
    beta = varb > 0 ? cov / varb : null;
  }

  let peak = -Infinity, mdd = 0;
  const dd = series.map((p) => {
    peak = Math.max(peak, p.value);
    const d = p.value / peak - 1;
    mdd = Math.min(mdd, d);
    return { date: p.date, dd: d };
  });

  // 벤치 가용 구간 기준 — 발행 측 벤치 조회가 fail-soft(null)라 결손일이 첫/끝에
  // 끼어도 α가 '데이터 없음'으로 무너지지 않게, 벤치가 있는 첫~끝 점의 동일
  // 구간에서 전략·벤치 수익률을 비교한다(벤치 전량 존재 시 기존 계산과 동일).
  let benchReturn = null, alpha = null;
  const benchPts = series.filter((p) => p.benchmark);
  if (benchPts.length >= 2) {
    const bFirst = benchPts[0], bLast = benchPts[benchPts.length - 1];
    benchReturn = bLast.benchmark / bFirst.benchmark - 1;
    alpha = (bLast.value / bFirst.value - 1) - benchReturn;   // 동일 구간 초과수익 (%p)
  }

  return { totalReturn, cagr, sharpe, vol, beta, winRate, mdd, dd, benchReturn, alpha,
           years, lastValue: last.value, days: series.length };
}

/* 기간별 수익률 — 최근 N거래일·YTD·전체 구간 누적 수익률.
   현재가치(curValue)는 장중 스냅샷 보정값을 받아 최신 기준으로 계산. */
function periodReturns(series, curValue) {
  if (!series.length) return [];
  const cur = curValue || series[series.length - 1].value;
  const back = (n) => series[Math.max(0, series.length - 1 - n)].value;
  const curYear = series[series.length - 1].date.slice(0, 4);
  const ytdBase = (series.find((p) => p.date.slice(0, 4) === curYear) || series[0]).value;
  return [
    { label: "1개월", ret: cur / back(21) - 1 },
    { label: "3개월", ret: cur / back(63) - 1 },
    { label: "6개월", ret: cur / back(126) - 1 },
    { label: "YTD", ret: cur / ytdBase - 1 },
    { label: "1년 (누적)", ret: cur / series[0].value - 1 },
  ];
}

/* ── SVG 헬퍼 ───────────────────────────────────────────── */
const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function niceTicks(min, max, n = 5) {
  const span = max - min || 1;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || mag * 10;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(t);
  return ticks;
}

function dateLabel(iso) { return iso.slice(2).replace(/-/g, "."); }

/* ── 자산 추이 차트 ──────────────────────────────────────── */
function renderEquityChart(host, series, tooltip) {
  host.innerHTML = "";
  if (series.length < 2) {
    host.innerHTML = '<p class="loading">표시할 데이터가 부족합니다</p>';
    return;
  }
  const W = 1000, H = 380, M = { t: 14, r: 16, b: 26, l: 56 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  const base = series[0].value;
  const benchBase = series[0].benchmark;
  const port = series.map((p) => p.value / base - 1);
  const bench = benchBase
    ? series.map((p) => (p.benchmark ? p.benchmark / benchBase - 1 : null))
    : null;

  let lo = Math.min(0, ...port), hi = Math.max(0, ...port);
  if (bench) {
    const bs = bench.filter((v) => v !== null);
    lo = Math.min(lo, ...bs); hi = Math.max(hi, ...bs);
  }
  const pad = (hi - lo) * 0.06 || 0.01;
  lo -= pad; hi += pad;

  const x = (i) => M.l + (i / (series.length - 1)) * iw;
  const y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * ih;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });

  // 그라디언트
  const defs = svgEl("defs");
  defs.innerHTML =
    `<linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
       <stop offset="0%" stop-color="${css("--up")}" stop-opacity=".18"/>
       <stop offset="100%" stop-color="${css("--up")}" stop-opacity="0"/>
     </linearGradient>`;
  svg.appendChild(defs);

  // 레짐 밴드 (연속 구간 병합 — 짧은 구간은 줄무늬 노이즈라 생략, 기간에 비례)
  const minSeg = Math.max(1, Math.round(series.length / 60));
  let segStart = 0;
  for (let i = 1; i <= series.length; i++) {
    if (i === series.length || series[i].regime !== series[segStart].regime) {
      const rg = series[segStart].regime;
      const varName = REGIME_VAR[rg];
      if (varName && i - segStart >= minSeg) {
        svg.appendChild(svgEl("rect", {
          x: x(segStart), y: M.t,
          width: Math.max(x(Math.min(i, series.length - 1)) - x(segStart), 0.5),
          height: ih, fill: css(varName) || "transparent",
        }));
      }
      segStart = i;
    }
  }

  // 그리드 + Y축 라벨
  for (const t of niceTicks(lo, hi, 5)) {
    svg.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: y(t), y2: y(t), class: "gridline" }));
    const lbl = svgEl("text", { x: M.l - 8, y: y(t) + 3.5, "text-anchor": "end", class: "axis-label" });
    lbl.textContent = fmtPct(t, 0);
    svg.appendChild(lbl);
  }

  // X축 라벨 (5~6개)
  const nx = Math.min(6, series.length);
  for (let k = 0; k < nx; k++) {
    const i = Math.round((k / (nx - 1)) * (series.length - 1));
    const lbl = svgEl("text", {
      x: x(i), y: H - 7,
      "text-anchor": k === 0 ? "start" : k === nx - 1 ? "end" : "middle",
      class: "axis-label",
    });
    lbl.textContent = dateLabel(series[i].date);
    svg.appendChild(lbl);
  }

  // 0% 기준선
  if (lo < 0 && hi > 0)
    svg.appendChild(svgEl("line", {
      x1: M.l, x2: W - M.r, y1: y(0), y2: y(0),
      stroke: css("--line-strong"), "stroke-width": 1,
    }));

  // 영역 + 라인
  const lineD = port.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  svg.appendChild(svgEl("path", {
    d: `${lineD}L${x(series.length - 1)},${y(lo)}L${x(0)},${y(lo)}Z`, class: "port-area",
  }));

  if (bench) {
    const bD = bench.map((v, i) =>
      v === null ? "" : `${i && bench[i - 1] !== null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    svg.appendChild(svgEl("path", { d: bD, class: "bench-line" }));
  }

  const portPath = svgEl("path", { d: lineD, class: "port-line draw-in" });
  svg.appendChild(portPath);

  // 크로스헤어
  const xline = svgEl("line", { class: "crosshair", y1: M.t, y2: M.t + ih, visibility: "hidden" });
  const dotP = svgEl("circle", { r: 4, class: "cross-dot", visibility: "hidden" });
  const dotB = svgEl("circle", { r: 3.5, class: "cross-dot bench", visibility: "hidden" });
  svg.append(xline, dotP, dotB);

  const overlay = svgEl("rect", {
    x: M.l, y: M.t, width: iw, height: ih, fill: "transparent",
    tabindex: "0", role: "application",
    "aria-label": "일별 값 탐색 — 좌우 화살표 키로 이동",
  });
  svg.appendChild(overlay);
  host.appendChild(svg);

  // 인트로 라인 길이
  requestAnimationFrame(() => {
    try {
      const len = portPath.getTotalLength();
      portPath.style.setProperty("--len", len);
    } catch { /* 비표시 상태 등 */ }
  });

  const live = document.getElementById("chart-live");

  const showIndex = (i, clientX, clientY) => {
    const p = series[i];
    xline.setAttribute("x1", x(i)); xline.setAttribute("x2", x(i));
    xline.setAttribute("visibility", "visible");
    dotP.setAttribute("cx", x(i)); dotP.setAttribute("cy", y(port[i]));
    dotP.setAttribute("visibility", "visible");
    if (bench && bench[i] !== null) {
      dotB.setAttribute("cx", x(i)); dotB.setAttribute("cy", y(bench[i]));
      dotB.setAttribute("visibility", "visible");
    } else dotB.setAttribute("visibility", "hidden");

    const regimeText = REGIME_LABEL[p.regime] || p.regime || "";
    tooltip.innerHTML =
      `<div class="tt-date">${esc(p.date)}</div>` +
      `<div><span class="${port[i] >= 0 ? "pos" : "neg"}">${fmtPct(port[i])}</span>` +
      ` · ₩${fmtKRW(p.value)}</div>` +
      (bench && bench[i] !== null
        ? `<div style="color:${css("--gold")}">벤치 ${fmtPct(bench[i])}</div>` : "") +
      `<div class="tt-regime">${esc(regimeText)}</div>`;
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    const left = Math.max(8, Math.min(clientX + 14, window.innerWidth - tw - 10));
    let top = clientY + 16;
    if (top + th > window.innerHeight - 8) top = clientY - th - 12;  // 아래 공간 없으면 위로
    tooltip.style.left = left + "px";
    tooltip.style.top = Math.max(8, top) + "px";
    if (live) live.textContent =
      `${p.date}, 수익률 ${fmtPct(port[i])}, 평가액 ${fmtKRW(p.value)}원, 레짐 ${regimeText}`;
    return i;
  };

  const idxFromEvent = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    return Math.max(0, Math.min(series.length - 1,
      Math.round(((px - M.l) / iw) * (series.length - 1))));
  };
  const hide = () => {
    tooltip.hidden = true;
    for (const el of [xline, dotP, dotB]) el.setAttribute("visibility", "hidden");
  };

  let kbIndex = series.length - 1;   // 키보드 탐색 위치 (기본: 최신일)
  const showKb = () => {
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + (x(kbIndex) / W) * rect.width;
    const cy = rect.top + (y(port[kbIndex]) / H) * rect.height;
    showIndex(kbIndex, cx, cy);
  };

  overlay.addEventListener("mousemove", (ev) => showIndex(idxFromEvent(ev), ev.clientX, ev.clientY));
  overlay.addEventListener("mouseleave", hide);
  overlay.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; showIndex(idxFromEvent(t), t.clientX, t.clientY);
  }, { passive: true });
  overlay.addEventListener("touchmove", (e) => {
    const t = e.touches[0]; showIndex(idxFromEvent(t), t.clientX, t.clientY);
  }, { passive: true });
  overlay.addEventListener("touchend", hide);
  overlay.addEventListener("focus", showKb);
  overlay.addEventListener("blur", hide);
  overlay.addEventListener("keydown", (ev) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -21, PageDown: 21 }[ev.key];
    if (step) kbIndex = Math.max(0, Math.min(series.length - 1, kbIndex + step));
    else if (ev.key === "Home") kbIndex = 0;
    else if (ev.key === "End") kbIndex = series.length - 1;
    else if (ev.key === "Escape") { hide(); return; }
    else return;
    ev.preventDefault();
    showKb();
  });
}

/* ── 자산 배분 도넛 (보유 종목별) ────────────────────────── */
// 종목 슬라이스 색 — 라이트/다크 양쪽에서 구분되는 카테고리 팔레트
const ALLOC_PALETTE = [
  "#e7b75f", "#3aa98c", "#a770ff", "#4d8dff", "#ff4d57",
  "#5cc8c0", "#e57ab0", "#8aa0b8",
];

function renderAlloc(host, slices) {
  host.innerHTML = "";
  if (!slices.length) {
    host.innerHTML = '<p class="loading">보유 종목 데이터 없음</p>';
    return;
  }
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const R = 52, RIN = 33, C = 60, GAP = 0.014;   // 도넛 반경·중심·슬라이스 간격
  const svg = svgEl("svg", { viewBox: "0 0 120 120", class: "donut-svg", "aria-hidden": "true" });
  let ang = -Math.PI / 2;   // 12시 방향 시작
  const polar = (r, a) => [C + r * Math.cos(a), C + r * Math.sin(a)];
  slices.forEach((s, i) => {
    const frac = s.value / total;
    const a0 = ang + GAP, a1 = ang + frac * 2 * Math.PI - GAP;
    ang += frac * 2 * Math.PI;
    if (a1 <= a0) return;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = polar(R, a0), [x1, y1] = polar(R, a1);
    const [xi1, yi1] = polar(RIN, a1), [xi0, yi0] = polar(RIN, a0);
    const d = `M${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`
      + ` L${xi1.toFixed(2)},${yi1.toFixed(2)} A${RIN},${RIN} 0 ${large} 0 ${xi0.toFixed(2)},${yi0.toFixed(2)} Z`;
    const path = svgEl("path", { d, fill: s.color || ALLOC_PALETTE[i % ALLOC_PALETTE.length] });
    const title = svgEl("title");
    title.textContent = `${s.label} ${(frac * 100).toFixed(1)}%`;
    path.appendChild(title);
    svg.appendChild(path);
  });
  // 중앙 라벨 — 보유 종목 수
  const holdN = slices.filter((s) => !s.cash).length;
  const big = svgEl("text", { x: C, y: C - 2, "text-anchor": "middle", class: "donut-center-num" });
  big.textContent = String(holdN);
  const small = svgEl("text", { x: C, y: C + 12, "text-anchor": "middle", class: "donut-center-lbl" });
  small.textContent = "종목";
  svg.append(big, small);

  const legend = document.createElement("ul");
  legend.className = "alloc-legend";
  legend.innerHTML = slices.map((s, i) => `
    <li>
      <span class="dot" style="--c:${s.color || ALLOC_PALETTE[i % ALLOC_PALETTE.length]}"></span>
      <span class="alloc-name">${esc(s.label)}</span>
      <span class="alloc-pct">${((s.value / total) * 100).toFixed(0)}%</span>
    </li>`).join("");

  const wrap = document.createElement("div");
  wrap.className = "donut-wrap";
  wrap.append(svg);
  host.append(wrap, legend);
}

/* ── 보유 상위 종목 테이블 ───────────────────────────────── */
function renderHoldings(holdings) {
  const body = $("#holdings-body");
  if (!holdings.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="4">보유 종목 데이터가 없습니다</td></tr>`;
    $("#holdings-count").textContent = "";
    return;
  }
  $("#holdings-count").textContent = `전체 ${holdings.length}종목`;
  body.innerHTML = holdings.map((h) => {
    const plCls = h.pl >= 0 ? "pos" : "neg";
    const retCls = h.ret >= 0 ? "pos" : "neg";
    return `<tr>
      <td class="td-name">${esc(h.name)}<span class="ticker">${esc(h.ticker)}</span></td>
      <td class="num">${(h.weight * 100).toFixed(1)}%</td>
      <td class="num ${h.pl != null ? plCls : ""}">${h.pl != null ? fmtSignWon(h.pl) : "—"}</td>
      <td class="num ${h.ret != null ? retCls : ""}">${h.ret != null ? fmtPct(h.ret) : "—"}</td>
    </tr>`;
  }).join("");
}

/* ── 리스크 지표 ─────────────────────────────────────────── */
function renderRisk(m) {
  const host = $("#risk-list");
  if (!m) { host.innerHTML = '<p class="loading">집계 전</p>'; return; }
  const rows = [
    { label: "변동성 (연)", value: (m.vol * 100).toFixed(1) + "%", cls: "" },
    { label: "샤프지수", value: m.sharpe.toFixed(2), cls: "accent" },
    { label: "최대낙폭 (MDD)", value: fmtPct(m.mdd), cls: "neg" },
    { label: "베타 (β)", value: m.beta != null ? m.beta.toFixed(2) : "—", cls: "" },
  ];
  host.innerHTML = rows.map((r) => `
    <div class="risk-row">
      <dt>${r.label}</dt>
      <dd class="${r.cls}">${r.value}</dd>
    </div>`).join("");
}

/* ── 기간별 수익률 (막대) ────────────────────────────────── */
function renderPeriods(host, periods) {
  const maxAbs = Math.max(0.0001, ...periods.map((p) => Math.abs(p.ret)));
  host.innerHTML = periods.map((p) => {
    const cls = p.ret >= 0 ? "pos" : "neg";
    const w = (Math.abs(p.ret) / maxAbs) * 100;
    return `
      <div class="period-row">
        <span class="period-label">${esc(p.label)}</span>
        <span class="period-bar"><i class="${cls}" style="width:${w.toFixed(1)}%"></i></span>
        <span class="period-val ${cls}">${fmtPct(p.ret)}</span>
      </div>`;
  }).join("");
}

/* ── 모닝 브리프 — 섹터·매크로·지수 레벨만 (종목 권고 없음, 준법) ── */
const STANCE_CLS = { "긍정": "act-up", "부정": "act-down", "중립": "act-hold" };

/* "2026-06-09" → "6월 9일" (제목 노출용) */
function briefDateKo(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${+m[2]}월 ${+m[3]}일` : String(iso || "");
}

function renderBriefing(doc, dateStr) {
  // 제목 — "<날짜> 시황 예상"
  const d = dateStr || doc.date || "";
  $("#briefing-title-date").textContent =
    (d ? `${briefDateKo(d)} ` : "") + "시황 예상";

  // 헤드라인(one_liner) — 항상 노출. 상세 본문은 '상세보기'로 펼침
  $("#briefing-headline").textContent = doc.one_liner || "";

  const host = $("#briefing-body");
  const outlook = String(doc.market_outlook || "")
    .split(/\n{2,}|\n/).filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`).join("");
  const viewRows = (list) => (list || []).map((s) => `
    <tr>
      <td>${esc(s.sector)}</td>
      <td><span class="act ${STANCE_CLS[s.stance] || "act-hold"}">${esc(s.stance)}</span></td>
      <td class="td-rationale">${esc(s.comment || "")}</td>
    </tr>`).join("");
  const sectors = viewRows(doc.sector_views);
  const macros = viewRows(doc.macro_views);

  host.innerHTML = `
    <p class="brief-meta">${esc((doc.generated_at || "").slice(0, 16).replace("T", " "))} 생성</p>
    <div class="brief-outlook">${outlook}</div>
    ${doc.index_view ? `
      <h3 class="brief-h">지수 전망</h3>
      <div class="brief-outlook"><p>${esc(doc.index_view)}</p></div>` : ""}
    ${(doc.key_drivers || []).length ? `
      <h3 class="brief-h">핵심 변수</h3>
      <div class="chips">${doc.key_drivers.map((d) => `<span class="chip">${esc(d)}</span>`).join("")}</div>` : ""}
    ${sectors ? `
      <h3 class="brief-h">업종 시각</h3>
      <div class="table-wrap"><table class="picks">
        <thead><tr><th>업종</th><th>시각</th><th>근거</th></tr></thead>
        <tbody>${sectors}</tbody>
      </table></div>` : ""}
    ${macros ? `
      <h3 class="brief-h">매크로 시각</h3>
      <div class="table-wrap"><table class="picks">
        <thead><tr><th>변수</th><th>시각</th><th>근거</th></tr></thead>
        <tbody>${macros}</tbody>
      </table></div>` : ""}
    ${(doc.risks || []).length ? `
      <h3 class="brief-h">리스크</h3>
      <ul class="brief-risks">${doc.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    <p class="brief-disclaimer">${esc(doc.disclaimer ||
      "본 브리핑은 AI가 자동 생성한 참고 자료이며 투자 권유가 아닙니다.")}</p>`;
  $("#briefing-demo").hidden = !doc.demo;
}

async function initBriefings() {
  let idx;
  try {
    idx = await fetchJSON("data/briefings/index.json");
  } catch {
    return;   // 브리핑 데이터 없음 — 패널 비표시
  }
  const dates = (idx.dates || []).slice().sort().reverse();
  if (!dates.length) return;

  const panel = $("#briefing-panel");
  const sel = $("#briefing-select");
  sel.innerHTML = dates.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");

  const load = async (d) => {
    try {
      renderBriefing(await fetchJSON(`data/briefings/${d}.json`), d);
      panel.hidden = false;
    } catch { /* 단일 브리핑 로드 실패 — 무시 */ }
  };
  sel.addEventListener("change", () => load(sel.value));

  // '상세보기' 토글 — 헤드라인 아래 상세 본문 펼침/접기
  const toggle = $("#briefing-toggle");
  const body = $("#briefing-body");
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    body.hidden = open;
    toggle.textContent = open ? "상세보기" : "접기";
  });

  await load(dates[0]);
}

/* ── KPI (히어로 3카드) ─────────────────────────────────── */
function renderKPIs(host, m, meta, dayChange) {
  if (!m) { host.innerHTML = '<p class="loading">성과 지표 집계 전</p>'; return; }
  const sign = (v) => (v >= 0 ? "pos" : "neg");
  const benchName = meta.benchmark || "벤치마크";

  // 1) 총 자산 — 전일 대비 변화 뱃지
  const dc = dayChange || {};
  const dcSign = (dc.pct ?? 0) >= 0;
  const cards = [`
    <article class="kpi-card">
      <h3 class="kpi-label">총 자산 <span class="kpi-label-sub">(원금 ${fmtWonFull(meta.initial_capital)})</span></h3>
      <p class="kpi-value">${fmtWonFull(m.lastValue)}</p>
      ${dc.pct != null ? `
        <p class="kpi-foot">
          <span class="kpi-chip ${dcSign ? "pos" : "neg"}">${dcSign ? "▲" : "▼"} ${fmtPct(dc.pct)}</span>
          <span class="kpi-foot-dim">전일 대비 ${fmtSignWon(dc.abs)}</span>
        </p>` : ""}
    </article>`,
  // 2) 누적 수익률 — 연환산(CAGR) 보조
    `<article class="kpi-card">
      <h3 class="kpi-label">누적 수익률</h3>
      <p class="kpi-value big ${sign(m.totalReturn)}">${fmtPct(m.totalReturn)}<span class="kpi-value-amt">(${fmtSignWon(m.lastValue - (meta.initial_capital || m.lastValue))})</span></p>
      <p class="kpi-foot"><span class="kpi-foot-dim">연환산 수익률</span>
        <strong class="${sign(m.cagr)}">${fmtPct(m.cagr)}</strong>
        <span class="kpi-foot-dim">(${fmtSignWon((meta.initial_capital || m.lastValue) * m.cagr)})</span></p>
    </article>`,
  // 3) vs 벤치마크 — α(%p)
    `<article class="kpi-card">
      <h3 class="kpi-label">vs ${esc(benchName)}</h3>
      <p class="kpi-value big ${m.alpha != null ? sign(m.alpha) : ""}">${m.alpha != null ? fmtPct(m.alpha) + "p" : "—"}</p>
      <p class="kpi-foot">
        <span class="kpi-foot-dim">포트폴리오 <strong class="${sign(m.totalReturn)}">${fmtPct(m.totalReturn)}</strong></span>
        <span class="kpi-foot-dim">${esc(benchName)} ${m.benchReturn != null ? `<strong class="${sign(m.benchReturn)}">${fmtPct(m.benchReturn)}</strong>` : "—"}</span>
      </p>
    </article>`,
  ];
  host.innerHTML = cards.join("");
}

/* ── 매매 테이블 ─────────────────────────────────────────── */
const PAGE = 20;

function renderTrades(state) {
  const { trades, side, month, shown } = state;
  const body = $("#trades-body");
  const filtered = trades.filter((t) =>
    (side === "all" || t.side === side) &&
    (month === "all" || t.ts.slice(0, 7) === month));

  $("#trades-desc").textContent =
    `${fmtNum(filtered.length)}건` + (month !== "all" ? ` · ${month}` : " · 전체 기간");

  if (!filtered.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">조건에 맞는 매매 내역이 없습니다</td></tr>`;
    $("#trades-more").hidden = true;
    return;
  }

  const rows = filtered.slice(0, shown).map((t) => {
    const dt = t.ts.slice(0, 16).replace("T", " ");
    const rgVar = REGIME_VAR[t.regime];
    return `<tr>
      <td class="td-date">${esc(dt)}</td>
      <td class="td-name">${esc(t.name)}<span class="ticker">${esc(t.ticker)}</span></td>
      <td><span class="side ${t.side === "buy" ? "buy" : "sell"}">${t.side === "buy" ? "매수" : "매도"}</span>${t.liquidation ? '<span class="liq">청산</span>' : ""}</td>
      <td class="num">${fmtNum(t.qty)}</td>
      <td class="num">${fmtNum(Math.round(t.price))}</td>
      <td class="num">₩${fmtKRW(t.amount)}</td>
      <td><span class="rg-chip" style="--chip:${rgVar ? `var(${rgVar})` : "var(--bg-raise-2)"}">${esc(REGIME_LABEL[t.regime] || t.regime || "—")}</span></td>
      <td class="td-reason" title="${esc(t.reason || "")}">${esc(t.reason || "—")}</td>
    </tr>`;
  });
  body.innerHTML = rows.join("");
  $("#trades-more").hidden = filtered.length <= shown;
}

/* ── 테마 토글 ──────────────────────────────────────────── */
// 초기 테마는 <head>의 인라인 부트스트랩이 이미 적용. 여기선 버튼·전환만 담당.
// onChange: 색을 CSS 변수에서 읽어 굽는 SVG 차트를 다시 그리는 콜백.
function initThemeToggle(onChange) {
  const btn = $("#theme-toggle");
  if (!btn) return;
  const root = document.documentElement;
  const apply = (theme) => {
    root.setAttribute("data-theme", theme);
    btn.setAttribute("aria-pressed", String(theme === "light"));
  };
  apply(root.getAttribute("data-theme") || "dark");
  btn.addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    apply(next);
    try { localStorage.setItem("gazua-theme", next); } catch { /* 사파리 사생활 모드 등 */ }
    if (typeof onChange === "function") onChange();
  });
}

/* ── 부트스트랩 ──────────────────────────────────────────── */
(async function main() {
  const app = $("#app");
  let data;
  try {
    data = await loadAll();
  } catch (e) {
    app.innerHTML = `<div class="error-box">
      <strong>데이터를 불러오지 못했습니다.</strong><br>
      ${esc(e.message)}<br><br>
      아직 매매 기록이 없거나, 로컬에서 직접 연 경우 정적 서버가 필요합니다
      (<code>python3 -m http.server</code>).</div>`;
    app.removeAttribute("aria-busy");
    return;
  }

  const { meta, series, months, trades, intraday } = data;
  const snaps = (intraday && intraday.snapshots) || [];
  const lastSnap = snaps.length ? snaps[snaps.length - 1] : null;

  // 마스트헤드
  const modeBadge = $("#mode-badge");
  modeBadge.hidden = false;
  if (meta.mode === "live") { modeBadge.textContent = "실거래"; modeBadge.classList.add("live"); }
  else { modeBadge.textContent = "모의투자"; modeBadge.classList.add("paper"); }
  if (meta.demo) $("#demo-badge").hidden = false;
  // 갱신 시각 — 장중 스냅샷이 meta보다 최신이면 그 시각을 보여준다
  const updatedTs = lastSnap && (!meta.updated_at || lastSnap.ts > meta.updated_at)
    ? lastSnap.ts : meta.updated_at;
  if (updatedTs)
    $("#updated-at").textContent = "갱신 " + updatedTs.slice(0, 16).replace("T", " ");

  $("#foot-note").textContent = meta.demo
    ? "⚠ 현재 표시 중인 데이터는 동일 전략의 실데이터 백테스트 출력(샘플)입니다. 실거래 기록이 아닙니다."
    : (meta.mode === "live"
        ? "실계좌 거래 기록입니다. 과거 수익률은 미래 수익을 보장하지 않습니다."
        : "KIS 모의투자 계좌 기록입니다. 과거 수익률은 미래 수익을 보장하지 않습니다.");

  if (!series.length) {
    app.innerHTML = `<div class="error-box"><strong>아직 기록이 없습니다.</strong><br>
      에이전트가 첫 매매를 실행하면 이곳에 수익률과 매매 내역이 나타납니다.</div>`;
    app.removeAttribute("aria-busy");
    return;
  }

  // 본문 템플릿 장착
  app.innerHTML = "";
  app.appendChild($("#tpl-dashboard").content.cloneNode(true));
  app.removeAttribute("aria-busy");

  // 모닝 브리프 — 성과 데이터와 무관하므로 가장 먼저, 비차단으로 렌더.
  // (성과/차트 렌더가 실패하더라도 시황은 항상 표시되도록 분리)
  initBriefings();   // 모닝 브리프 (데이터 있을 때만 표시 — 비차단)

  const metrics = computeMetrics(series, meta.initial_capital);

  // 장중 스냅샷이 있으면 헤더 KPI의 현재가치 계열만 최신값으로 보정
  // (CAGR·샤프·MDD 등 일별 표본 기반 지표는 일별 확정치 그대로 둔다)
  if (metrics && lastSnap) {
    metrics.lastValue = lastSnap.value;
    metrics.totalReturn = lastSnap.value / (meta.initial_capital || series[0].value) - 1;
    const b0 = series.find((p) => p.benchmark);
    if (b0 && lastSnap.benchmark) {
      metrics.benchReturn = lastSnap.benchmark / b0.benchmark - 1;
      metrics.alpha = (lastSnap.value / b0.value - 1) - metrics.benchReturn;
    }
  }
  // 전일 대비 변화 — 스냅샷이 시리즈 마지막일보다 새 날짜면 마지막 종가가 전일,
  // 같은 날이면 그 직전 거래일 종가가 전일.
  const dayChange = (() => {
    const cur = metrics.lastValue;
    const lastDate = series[series.length - 1].date;
    let prev;
    if (lastSnap && lastSnap.ts.slice(0, 10) > lastDate) prev = series[series.length - 1].value;
    else if (series.length >= 2) prev = series[series.length - 2].value;
    else return {};
    return prev ? { pct: cur / prev - 1, abs: cur - prev } : {};
  })();
  renderKPIs($("#kpis"), metrics, meta, dayChange);

  $("#bench-name").textContent = meta.benchmark || "벤치마크";
  $("#legend-bench").textContent = meta.benchmark || "벤치마크";

  // 레짐 범례 (등장한 레짐만)
  const seen = [...new Set(series.map((p) => p.regime).filter(Boolean))];
  $("#legend-regimes").innerHTML = seen.map((r) =>
    `<span class="key-rg" style="--swatch:${`var(${REGIME_VAR[r] || "--bg-raise-2"})`}">${esc(REGIME_LABEL[r] || r)}</span>`).join("");

  // ── 보유 종목·자산 배분 — 장중 스냅샷의 positions·cash 기반 ──
  // 종목명: 매매 기록 → 유니버스 순으로 조회. 평단가: 매수 가중평균(평균법).
  const nameMap = {};
  for (const u of (meta.universe || [])) nameMap[u.ticker] = u.name;
  for (const t of trades) nameMap[t.ticker] = t.name;
  const avgCost = {};
  const buyAgg = {};
  for (const t of trades) {
    if (t.side !== "buy") continue;
    const a = buyAgg[t.ticker] || (buyAgg[t.ticker] = { amt: 0, qty: 0 });
    a.amt += t.amount; a.qty += t.qty;
  }
  for (const [tk, a] of Object.entries(buyAgg)) if (a.qty > 0) avgCost[tk] = a.amt / a.qty;

  const totalValue = (lastSnap && lastSnap.value) || metrics.lastValue;
  const positions = (lastSnap && lastSnap.positions) || [];
  const holdings = positions.map((p) => {
    const mktval = p.qty * p.price;
    const cost = avgCost[p.ticker];
    return {
      ticker: p.ticker, name: nameMap[p.ticker] || p.ticker,
      mktval, weight: totalValue ? mktval / totalValue : 0,
      pl: cost != null ? (p.price - cost) * p.qty : null,
      ret: cost != null && cost > 0 ? p.price / cost - 1 : null,
    };
  }).sort((a, b) => b.mktval - a.mktval);
  renderHoldings(holdings);

  // 자산 배분 — 보유 종목별 + 현금성
  const allocSlices = holdings.map((h, i) => ({
    label: h.name, value: h.mktval, color: ALLOC_PALETTE[i % ALLOC_PALETTE.length],
  }));
  const cash = lastSnap && lastSnap.cash;
  if (cash && cash > 0) allocSlices.push({ label: "현금성", value: cash, color: "#8aa0b8", cash: true });
  renderAlloc($("#alloc"), allocSlices);

  // 리스크 지표 · 기간별 수익률
  renderRisk(metrics);
  renderPeriods($("#period-list"), periodReturns(series, metrics.lastValue));

  // 차트 — 운용 성과(현재 선택 구간)·자산 배분은 테마 전환 시 색을 다시 굽기 위해 재렌더 가능하게 분리
  const tooltip = $("#tooltip");
  const sliceRange = (range) => {
    if (range === "ALL") return series;
    if (range === "YTD") {
      const y = series[series.length - 1].date.slice(0, 4);
      const start = series.findIndex((p) => p.date.slice(0, 4) === y);
      return series.slice(start >= 0 ? start : 0);
    }
    const n = { "1M": 21, "3M": 63, "6M": 126 }[range] || series.length;
    return series.slice(-Math.min(n, series.length));
  };
  let curRange = "ALL";
  const drawCharts = () => {
    renderEquityChart($("#equity-chart"), sliceRange(curRange), tooltip);
    renderAlloc($("#alloc"), allocSlices);
  };
  drawCharts();

  $("#range-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-range]");
    if (!btn) return;
    for (const b of $("#range-toggle").children) b.classList.toggle("active", b === btn);
    curRange = btn.dataset.range;
    renderEquityChart($("#equity-chart"), sliceRange(curRange), tooltip);
  });

  // 테마 토글 — data-theme 전환·localStorage 저장·색 의존 차트 재렌더
  initThemeToggle(drawCharts);

  // 매매 테이블
  const state = { trades, side: "all", month: "all", shown: PAGE };
  const sel = $("#month-select");
  sel.innerHTML = `<option value="all">전체 월</option>` +
    months.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  sel.addEventListener("change", () => {
    state.month = sel.value; state.shown = PAGE; renderTrades(state);
  });
  $("#side-filter").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-side]");
    if (!btn) return;
    for (const b of $("#side-filter").children) b.classList.toggle("active", b === btn);
    state.side = btn.dataset.side; state.shown = PAGE; renderTrades(state);
  });
  $("#trades-more").addEventListener("click", () => {
    state.shown += PAGE; renderTrades(state);
  });
  renderTrades(state);

  // 모바일 가로 스크롤 affordance — 우측 페이드 (끝 도달·스크롤 불필요 시 숨김)
  const wrap = $(".table-wrap");
  if (wrap) {
    const fade = document.createElement("div");
    fade.className = "table-fade";
    fade.setAttribute("aria-hidden", "true");
    wrap.prepend(fade);
    const updateFade = () => {
      const scrollable = wrap.scrollWidth > wrap.clientWidth + 1;
      const atEnd = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 4;
      wrap.classList.toggle("at-end", !scrollable || atEnd);
      fade.style.setProperty("--fade-h", wrap.clientHeight + "px");
    };
    wrap.addEventListener("scroll", updateFade, { passive: true });
    window.addEventListener("resize", updateFade);
    new MutationObserver(updateFade).observe($("#trades-body"), { childList: true });
    updateFade();
  }
})();

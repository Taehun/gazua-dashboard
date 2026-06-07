"""데모 데이터 생성 — 가즈아(GAZUA) 실데이터 백테스트 출력을 대시보드 스키마로 변환.

실행 (stock-agent 의존성 사용):
    cd /path/to/stock-agent
    uv run python /path/to/gazua-dashboard/tools/generate_demo_data.py

생성물 (이 repo의 data/):
    data/meta.json           — 모드·초기자본·유니버스·갱신시각 (demo=true 표시)
    data/equity.json         — 일별 평가액 + 벤치마크(KOSPI200) + 레짐
    data/trades/index.json   — 월별 매매 파일 목록
    data/trades/YYYY-MM.json — 월별 매매 내역

⚠️ demo=true 데이터는 실거래가 아니라 동일 전략의 실데이터 백테스트 출력이다.
   운영 publisher가 실제 매매를 push하기 시작하면 demo=false로 교체된다.
"""

from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"
KST = timezone(timedelta(hours=9))

START = date(2024, 1, 2)     # warmup 300거래일 포함 — 출력은 ~2025-04부터
END = date(2026, 6, 5)
INITIAL_CASH = 100_000_000.0


async def main() -> None:
    from app.trading.backtest import run_backtest
    from app.trading.data import load_backtest_data_fdr
    from app.trading.settings import load_strategy

    cfg = load_strategy("config/strategy.yaml")
    tickers = [a.ticker for a in cfg.universe]
    names = {a.ticker: a.name for a in cfg.universe}

    print(f"실데이터 로드 — {START} ~ {END} ({len(tickers)} 종목)")
    data = load_backtest_data_fdr(
        tickers, START, END, factor_symbols=cfg.signals.global_factors.symbols
    )

    # ── SimBroker.submit_order 래핑 — 모든 체결을 기록 ──
    trades: list[dict] = []
    from app.trading.broker.sim import SimBroker

    orig_submit = SimBroker.submit_order

    async def recording_submit(self, order, *, idempotency_key):
        res = await orig_submit(self, order, idempotency_key=idempotency_key)
        day = idempotency_key.split(":", 1)[0]
        trades.append({
            "ts": f"{day}T09:00:00+09:00",   # 백테스트는 시가 체결
            "cycle_id": f"{day}-bt",
            "ticker": order.ticker,
            "name": names.get(order.ticker, order.ticker),
            "side": order.side.value,
            "qty": res.filled_qty,
            "price": round(res.avg_price, 2),
            "amount": round(res.filled_qty * res.avg_price),
            "status": res.status.value,
            "reason": order.reason,
            "liquidation": order.liquidation,
        })
        return res

    SimBroker.submit_order = recording_submit
    try:
        result = await run_backtest(data, cfg, initial_cash=INITIAL_CASH)
    finally:
        SimBroker.submit_order = orig_submit

    # ── equity.json — 일별 평가액 + 벤치마크 + 레짐 ──
    regimes = {d.date() if hasattr(d, "date") else d: r
               for d, r in result.regime_history.items()}
    bench = data.index_close
    series = []
    for d, v in result.daily_value.items():
        dd = d.date() if hasattr(d, "date") else d
        b = bench.loc[bench.index <= str(dd)]
        series.append({
            "date": dd.isoformat(),
            "value": round(float(v)),
            "benchmark": round(float(b.iloc[-1]), 2) if len(b) else None,
            "regime": regimes.get(dd, "neutral"),
        })

    # 매매 레짐 주석 (체결일의 레짐)
    for t in trades:
        t["regime"] = regimes.get(date.fromisoformat(t["ts"][:10]), "neutral")

    # ── 파일 쓰기 ──
    DATA.mkdir(exist_ok=True)
    (DATA / "trades").mkdir(exist_ok=True)

    (DATA / "equity.json").write_text(json.dumps(
        {"schema_version": 1, "series": series}, ensure_ascii=False, indent=1
    ) + "\n", encoding="utf-8")

    by_month: dict[str, list[dict]] = {}
    for t in trades:
        by_month.setdefault(t["ts"][:7], []).append(t)
    for month, items in sorted(by_month.items()):
        (DATA / "trades" / f"{month}.json").write_text(json.dumps(
            {"schema_version": 1, "month": month, "trades": items},
            ensure_ascii=False, indent=1,
        ) + "\n", encoding="utf-8")
    (DATA / "trades" / "index.json").write_text(json.dumps(
        {"schema_version": 1, "months": sorted(by_month)}, ensure_ascii=False
    ) + "\n", encoding="utf-8")

    meta = {
        "schema_version": 1,
        "title": "가즈아 (GAZUA)",
        "subtitle": "한국 주식 레짐 기반 자동매매 에이전트",
        "mode": "paper",
        "demo": True,        # 실데이터 백테스트 출력 (실거래 아님) — publisher가 false로 교체
        "currency": "KRW",
        "initial_capital": INITIAL_CASH,
        "inception": series[0]["date"] if series else None,
        "benchmark": "KOSPI 200",
        "universe": [{"ticker": a.ticker, "name": a.name, "role": a.role}
                     for a in cfg.universe],
        "updated_at": datetime.now(KST).isoformat(timespec="seconds"),
    }
    (DATA / "meta.json").write_text(json.dumps(
        meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    s = result.summary()
    print(f"완료 — equity {len(series)}일, trades {len(trades)}건 / "
          f"CAGR {s['cagr']:.1%} MDD {s['mdd']:.1%} Sharpe {s['sharpe']}")


if __name__ == "__main__":
    asyncio.run(main())

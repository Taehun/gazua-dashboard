#!/usr/bin/env python3
"""data/ 무결성 검증 — 대시보드가 읽는 JSON이 스키마·불변식을 지키는지 확인.

verify-data 스킬(.claude/skills/verify-data)의 결정적 신호원이다. 사람이든
에이전트든 data/ 를 건드린 뒤 이걸 돌려서 exit code 0 이 나와야 push 한다.

  ERROR  (exit 1) : 대시보드가 깨지거나 수치가 틀어지는 위반
  WARN   (exit 0) : 앱이 처리는 하지만 확인이 필요한 상태 (--strict 면 exit 1)

검사 항목:
  - 모든 JSON 파싱 가능, schema_version == 1
  - meta.json 필수 필드
  - equity.json: 날짜 ISO·오름차순·중복 없음·평일, value > 0, regime 존재
  - trades/index.json 의 months ↔ trades/YYYY-MM.json 파일 1:1
  - trades: 필수 필드, ts 가 파일의 month 에 속함, side ∈ {buy,sell},
    amount ≈ qty × price
  - 재구성(intraday_snapshot.reconstruct 와 동일 로직): 현금 ≥ 0, 보유수량 ≥ 0
  - intraday/*.json: 파일명 = date, 스냅샷 ts 오름차순, value ≈ cash + Σqty×price,
    보존 개수(90) 초과 여부
  - briefings/index.json 의 dates ↔ briefings/YYYY-MM-DD.json 파일 1:1

사용:
  python3 tools/verify_data.py            # 전체 검사
  python3 tools/verify_data.py --strict   # WARN 도 실패로 취급
"""
import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

sys.dont_write_bytecode = True  # tools/__pycache__ 를 남기지 않음
sys.path.insert(0, str(Path(__file__).resolve().parent))
from intraday_snapshot import DATA_DIR, RETENTION_FILES, reconstruct  # noqa: E402

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
TRADE_FIELDS = ("ts", "ticker", "name", "side", "qty", "price", "amount", "status")
META_FIELDS = ("title", "mode", "currency", "initial_capital", "inception",
               "benchmark", "universe", "updated_at")

errors, warnings = [], []


def err(where, msg):
    errors.append(f"{where}: {msg}")


def warn(where, msg):
    warnings.append(f"{where}: {msg}")


def rel(p):
    return str(p.relative_to(DATA_DIR.parent))


def load(path):
    try:
        doc = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        err(rel(path), f"JSON 로드 실패 — {e}")
        return None
    if isinstance(doc, dict) and doc.get("schema_version") != 1:
        err(rel(path), f"schema_version != 1 ({doc.get('schema_version')!r})")
    return doc


def check_meta():
    meta = load(DATA_DIR / "meta.json")
    if meta is None:
        return
    for k in META_FIELDS:
        if k not in meta:
            err("data/meta.json", f"필수 필드 누락: {k}")
    if not (isinstance(meta.get("initial_capital"), (int, float)) and meta["initial_capital"] > 0):
        err("data/meta.json", "initial_capital 이 양수가 아님")


def check_equity():
    where = "data/equity.json"
    doc = load(DATA_DIR / where[5:])
    if doc is None:
        return
    series = doc.get("series", [])
    if not series:
        warn(where, "series 가 비어 있음 (대시보드는 '기록 없음' 표시)")
    prev = None
    for i, p in enumerate(series):
        d = p.get("date", "")
        tag = f"{where} series[{i}] {d}"
        if not DATE_RE.match(d):
            err(tag, "date 형식 오류")
            continue
        if prev is not None and d <= prev:
            err(tag, f"날짜 역순 또는 중복 (직전 {prev})")
        prev = d
        if date.fromisoformat(d).weekday() >= 5:
            err(tag, "주말 날짜")
        if not (isinstance(p.get("value"), (int, float)) and p["value"] > 0):
            err(tag, f"value 가 양수가 아님 ({p.get('value')!r})")
        if not p.get("regime"):
            err(tag, "regime 누락")
        b = p.get("benchmark")
        if b is None:
            warn(tag, "benchmark 가 null (벤치마크 비교에서 제외됨)")
        elif not (isinstance(b, (int, float)) and b > 0):
            err(tag, f"benchmark 이상값 ({b!r})")


def check_trades():
    tdir = DATA_DIR / "trades"
    idx = load(tdir / "index.json")
    months = set(idx.get("months", [])) if idx else set()
    files = {f.stem for f in tdir.glob("????-??.json")}
    for m in sorted(months - files):
        err("data/trades/index.json", f"months 에 {m} 가 있지만 파일 없음")
    for m in sorted(files - months):
        err("data/trades/index.json", f"{m}.json 파일이 months 에 없음 (대시보드에서 안 보임)")

    for f in sorted(tdir.glob("????-??.json")):
        doc = load(f)
        if doc is None:
            continue
        where = rel(f)
        if doc.get("month") != f.stem:
            err(where, f"month 필드({doc.get('month')!r}) ≠ 파일명")
        for i, t in enumerate(doc.get("trades", [])):
            tag = f"{where} trades[{i}] {t.get('ts', '?')} {t.get('ticker', '?')}"
            missing = [k for k in TRADE_FIELDS if k not in t]
            if missing:
                err(tag, f"필수 필드 누락: {', '.join(missing)}")
                continue
            if not str(t["ts"]).startswith(f.stem):
                err(tag, "ts 가 파일의 month 에 속하지 않음")
            if t["side"] not in ("buy", "sell"):
                err(tag, f"side 이상값 ({t['side']!r})")
            if t["qty"] and abs(t["qty"] * t["price"] - t["amount"]) > max(1, t["amount"] * 1e-6):
                err(tag, f"amount({t['amount']}) ≠ qty×price({t['qty'] * t['price']})")
            if "fee" not in t:
                warn(tag, "fee 없음 (재구성 시 1.49bp 추정치 사용)")

    try:
        holdings, cash = reconstruct()
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as e:
        err("trades 재구성", f"실패 — {e!r}")
        return
    if cash < 0:
        err("trades 재구성", f"현금 음수 ₩{cash:,.0f} — 유령 체결/중복 기록 의심 "
            "(intraday cron 이 기록을 중단함)")
    for tk, q in holdings.items():
        if q < 0:
            err("trades 재구성", f"{tk} 보유수량 음수 ({q}) — 매수 없는 매도")


def check_intraday():
    idir = DATA_DIR / "intraday"
    files = sorted(idir.glob("*.json"))
    if len(files) > RETENTION_FILES:
        warn("data/intraday", f"파일 {len(files)}개 > 보존 {RETENTION_FILES}개 (다음 cron 에서 정리됨)")
    for f in files:
        doc = load(f)
        if doc is None:
            continue
        where = rel(f)
        if doc.get("date") != f.stem:
            err(where, f"date 필드({doc.get('date')!r}) ≠ 파일명")
        prev = None
        for i, s in enumerate(doc.get("snapshots", [])):
            tag = f"{where} snapshots[{i}] {s.get('ts', '?')}"
            ts = s.get("ts", "")
            if not ts.startswith(f.stem):
                err(tag, "ts 날짜 ≠ 파일 날짜")
            if prev is not None and ts <= prev:
                err(tag, "ts 역순 또는 중복")
            prev = ts
            try:
                mv = s["cash"] + sum(p["qty"] * p["price"] for p in s["positions"])
            except (KeyError, TypeError) as e:
                err(tag, f"필드 누락/형식 오류 — {e}")
                continue
            if abs(mv - s.get("value", 0)) > 1:
                err(tag, f"value({s.get('value')}) ≠ cash+Σqty×price({mv})")


def check_briefings():
    bdir = DATA_DIR / "briefings"
    if not bdir.exists():
        return
    idx = load(bdir / "index.json")
    dates = set(idx.get("dates", [])) if idx else set()
    files = {f.stem for f in bdir.glob("????-??-??.json")}
    for d in sorted(dates - files):
        err("data/briefings/index.json", f"dates 에 {d} 가 있지만 파일 없음")
    for d in sorted(files - dates):
        err("data/briefings/index.json", f"{d}.json 파일이 dates 에 없음 (선택 목록에서 안 보임)")
    for f in sorted(bdir.glob("????-??-??.json")):
        doc = load(f)
        if doc is not None and doc.get("date") != f.stem:
            err(rel(f), f"date 필드({doc.get('date')!r}) ≠ 파일명")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true", help="WARN 도 실패로 취급")
    opts = ap.parse_args()

    check_meta()
    check_equity()
    check_trades()
    check_intraday()
    check_briefings()

    # WARN 은 종류별로 묶어 건수 + 첫 위치만 (fee 없음·benchmark null 이 수십 건씩 쌓임)
    kinds = {}
    for w in warnings:
        kinds.setdefault(w.rsplit(": ", 1)[-1], []).append(w.rsplit(": ", 1)[0])
    for msg, locs in kinds.items():
        more = f" 외 {len(locs) - 1}건" if len(locs) > 1 else ""
        print(f"WARN  {msg} — {locs[0]}{more}")
    for e in errors:
        print(f"ERROR {e}")
    failed = bool(errors) or (opts.strict and bool(warnings))
    print(f"\n{'FAIL' if failed else 'PASS'} — errors={len(errors)} warnings={len(warnings)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

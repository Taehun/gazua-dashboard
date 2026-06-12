#!/usr/bin/env python3
"""시간별 포트폴리오 스냅샷 수집 — 레포 데이터만으로 재구성 (GitHub Actions cron).

외부 상태 없이 레포 안의 데이터만 사용한다:
  - 포지션·현금: meta.json의 initial_capital + trades/*.json 체결 내역 재구성
  - 현재가·벤치마크: 네이버 시세 API (종목 현재가, KOSPI200 지수)

결과를 data/intraday/YYYY-MM-DD.json 에 append 후 commit & push 한다.

다음 경우 스스로 아무것도 안 하고 끝난다:
  - KST 평일 08~18시 창 밖 (실행 환경 타임존과 무관하게 KST로 판정)
  - 직전 스냅샷과 평가액·벤치마크가 모두 동일 (휴장일 등)

재구성 현금이 음수면 trades 데이터 오염(유령 체결 등)이므로 기록하지 않고
에러로 종료한다.

옵션:
  --dry-run   스냅샷을 출력만 하고 파일·git 변경 없음
  --no-git    파일은 쓰되 git pull/commit/push 생략 (로컬 테스트용)
  --force     시간창·중복 검사 무시
"""
import argparse
import json
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
WINDOW_HOURS = range(8, 19)  # KST 08시~18시 (프리마켓 ~ 시간외 단일가 종료)
RETENTION_FILES = 90         # intraday 일별 파일 보존 개수
# trades에 fee 필드가 없어 수수료를 추정 차감한다. 실측값: 체결액의 1.49bp
# (2026-06-12, /trading/portfolio 현금과 대조). agent가 fee를 기록하면 대체할 것.
FEE_RATE = 0.000149
REPO_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_DIR / "data"
INTRADAY_DIR = DATA_DIR / "intraday"
NAVER_STOCK = "https://m.stock.naver.com/api/stock/{}/basic"
NAVER_KPI200 = "https://m.stock.naver.com/api/index/KPI200/basic"


def log(msg):
    print(f"[{datetime.now(KST).isoformat(timespec='seconds')}] {msg}", flush=True)


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def naver_price(ticker):
    return int(float(fetch_json(NAVER_STOCK.format(ticker))["closePrice"].replace(",", "")))


def reconstruct():
    """meta.json + trades/*.json 에서 보유 수량과 현금을 재구성."""
    meta = json.loads((DATA_DIR / "meta.json").read_text())
    cash = meta["initial_capital"]
    holdings = {}
    for f in sorted((DATA_DIR / "trades").glob("????-??.json")):
        for t in json.loads(f.read_text())["trades"]:
            if t["status"] != "filled":
                continue
            sign = 1 if t["side"] == "buy" else -1
            holdings[t["ticker"]] = holdings.get(t["ticker"], 0) + sign * t["qty"]
            cash -= sign * t["amount"] + t.get("fee", t["amount"] * FEE_RATE)
    return {tk: q for tk, q in holdings.items() if q}, cash


def git(*args, check=True):
    return subprocess.run(["git", "-C", str(REPO_DIR), *args],
                          capture_output=True, text=True, check=check)


def last_snapshot():
    """가장 최근 스냅샷 (오늘 파일 → 없으면 직전 파일)."""
    for f in sorted(INTRADAY_DIR.glob("*.json"), reverse=True):
        snaps = json.loads(f.read_text())["snapshots"]
        if snaps:
            return snaps[-1]
    return None


def prune_old_files():
    """보존 개수를 넘는 오래된 intraday 파일을 git rm."""
    files = sorted(INTRADAY_DIR.glob("*.json"))
    for f in files[:-RETENTION_FILES] if len(files) > RETENTION_FILES else []:
        git("rm", "-q", str(f))
        log(f"보존 정책: {f.name} 삭제")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-git", action="store_true")
    ap.add_argument("--force", action="store_true")
    opts = ap.parse_args()

    now = datetime.now(KST)
    if not opts.force and (now.weekday() >= 5 or now.hour not in WINDOW_HOURS):
        log("KST 거래 시간창(평일 08~18시) 밖 — 종료")
        return 0

    use_git = not (opts.no_git or opts.dry_run)
    if use_git:
        git("pull", "--rebase", "--quiet", "origin", "main")

    holdings, cash = reconstruct()
    if cash < 0:
        log(f"오류: 재구성 현금이 음수(₩{cash:,.0f}) — trades 데이터 오염 의심, 기록 중단")
        return 1

    positions = [{"ticker": tk, "qty": q, "price": naver_price(tk)}
                 for tk, q in sorted(holdings.items())]
    idx = fetch_json(NAVER_KPI200)
    benchmark = float(idx["closePrice"].replace(",", ""))

    snapshot = {
        "ts": now.isoformat(timespec="seconds"),
        "value": int(round(cash + sum(p["qty"] * p["price"] for p in positions))),
        "cash": int(round(cash)),
        "benchmark": benchmark,
        "market_status": idx.get("marketStatus", ""),
        "positions": positions,
    }

    if opts.dry_run:
        log("dry-run — 스냅샷 출력만:")
        print(json.dumps(snapshot, ensure_ascii=False, indent=1))
        return 0

    prev = last_snapshot() if INTRADAY_DIR.exists() else None
    if not opts.force and prev and \
            prev["value"] == snapshot["value"] and prev["benchmark"] == snapshot["benchmark"]:
        log(f"직전 스냅샷({prev['ts']})과 동일 — 휴장/무변동으로 보고 스킵")
        return 0

    INTRADAY_DIR.mkdir(parents=True, exist_ok=True)
    path = INTRADAY_DIR / f"{now.date()}.json"
    if path.exists():
        doc = json.loads(path.read_text())
    else:
        doc = {"schema_version": 1, "date": str(now.date()), "snapshots": []}
    doc["snapshots"].append(snapshot)
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    log(f"기록: {path.name} ← value=₩{snapshot['value']:,} benchmark={benchmark:,}")

    if not use_git:
        return 0

    prune_old_files()
    git("add", str(INTRADAY_DIR))
    if git("diff", "--cached", "--quiet", check=False).returncode == 0:
        log("변경 없음 — 커밋 생략")
        return 0
    git("commit", "-q", "-m",
        f"data: intraday {now.strftime('%Y-%m-%d %H:%M')} ₩{snapshot['value']:,}")
    push = git("push", "-q", "origin", "main", check=False)
    if push.returncode != 0:  # agent push와 경합 시 1회 재시도
        log("push 실패 — rebase 후 재시도")
        git("pull", "--rebase", "--quiet", "origin", "main")
        git("push", "-q", "origin", "main")
    log("push 완료")
    return 0


if __name__ == "__main__":
    sys.exit(main())

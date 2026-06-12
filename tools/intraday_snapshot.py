#!/usr/bin/env python3
"""시간별 포트폴리오 스냅샷 수집 — stock-agent 서버 cron에서 실행.

stock-agent의 /trading/portfolio API(진실 소스)에서 현금·보유 종목을 읽고,
네이버 시세 API에서 종목 현재가와 KOSPI200 지수를 받아
data/intraday/YYYY-MM-DD.json 에 스냅샷을 append 한 뒤 commit & push 한다.

cron은 매시간 무조건 실행해도 된다 — 다음 경우 스스로 아무것도 안 하고 끝난다:
  - KST 평일 08~18시 창 밖 (서버 타임존과 무관하게 KST로 판정)
  - 직전 스냅샷과 평가액·벤치마크가 모두 동일 (휴장일, 시간외 미체결 등)

crontab 예시 (서버 타임존 무관, 정각 혼잡 회피를 위해 7분):
  7 * * * * . "$HOME/.gazua-env"; cd "$HOME/gazua-dashboard" && \
    /usr/bin/flock -n /tmp/gazua-intraday.lock \
    python3 tools/intraday_snapshot.py >> "$HOME/gazua-intraday.log" 2>&1

환경변수:
  TRADING_API_TOKEN  (필수) stock-agent API 키
  PORTFOLIO_URL      (선택) 기본 http://127.0.0.1:8000/trading/portfolio

옵션:
  --dry-run   스냅샷을 출력만 하고 파일·git 변경 없음
  --no-git    파일은 쓰되 git pull/commit/push 생략 (로컬 테스트용)
  --force     시간창·중복 검사 무시
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
WINDOW_HOURS = range(8, 19)  # KST 08시~18시 (프리마켓 ~ 시간외 단일가 종료)
RETENTION_FILES = 90         # intraday 일별 파일 보존 개수
REPO_DIR = Path(__file__).resolve().parent.parent
INTRADAY_DIR = REPO_DIR / "data" / "intraday"
NAVER_STOCK = "https://m.stock.naver.com/api/stock/{}/basic"
NAVER_KPI200 = "https://m.stock.naver.com/api/index/KPI200/basic"


def log(msg):
    print(f"[{datetime.now(KST).isoformat(timespec='seconds')}] {msg}", flush=True)


def fetch_json(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", **(headers or {})})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def naver_price(ticker):
    try:
        d = fetch_json(NAVER_STOCK.format(ticker))
        return int(float(d["closePrice"].replace(",", "")))
    except Exception as e:
        log(f"경고: {ticker} 시세 조회 실패 ({e}) — price=null로 기록")
        return None


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

    token = os.environ.get("TRADING_API_TOKEN")
    if not token:
        log("오류: TRADING_API_TOKEN 환경변수가 없음")
        return 1
    portfolio_url = os.environ.get("PORTFOLIO_URL", "http://127.0.0.1:8000/trading/portfolio")

    portfolio = fetch_json(portfolio_url, headers={"X-API-Key": token})
    idx = fetch_json(NAVER_KPI200)
    benchmark = float(idx["closePrice"].replace(",", ""))

    snapshot = {
        "ts": now.isoformat(timespec="seconds"),
        "value": int(round(portfolio["total_value"])),
        "cash": int(round(portfolio["cash"])),
        "benchmark": benchmark,
        "market_status": idx.get("marketStatus", ""),
        "positions": [
            {"ticker": tk, "qty": q, "price": naver_price(tk)}
            for tk, q in sorted(portfolio["holdings"].items()) if q
        ],
    }

    if opts.dry_run:
        log("dry-run — 스냅샷 출력만:")
        print(json.dumps(snapshot, ensure_ascii=False, indent=1))
        return 0

    use_git = not opts.no_git
    if use_git:
        git("pull", "--rebase", "--quiet", "origin", "main")

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

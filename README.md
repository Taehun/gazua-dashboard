# 가즈아 (GAZUA) 대시보드

**가즈아(GAZUA)** — 한국 주식 자동매매 에이전틱 AI 시스템의
**매매 히스토리·수익률 추적 대시보드**

**Live: https://taehun.github.io/gazua-dashboard/**

## 구조

```
index.html            # 단일 페이지 대시보드
assets/style.css      # "야간 트레이딩 데스크" 테마 (다크, 한국 증시 컨벤션: 상승=적)
assets/app.js         # 수제 SVG 차트 + 렌더링 (vanilla JS)
data/
  meta.json           # 모드·초기자본·유니버스·갱신시각
  equity.json         # 일별 평가액 + 벤치마크(KOSPI200) + 레짐
  trades/index.json   # 월 목록
  trades/YYYY-MM.json # 월별 매매 내역
  intraday/YYYY-MM-DD.json     # 장중 시간별 스냅샷 (90일 보존)
tools/generate_demo_data.py  # 데모 데이터 재생성 (실데이터 백테스트 출력)
tools/intraday_snapshot.py   # 시간별 스냅샷 수집기 (stock-agent 서버 cron)
```

**의존성 0** — 빌드 도구·외부 라이브러리·외부 요청 없음. 숫자용 모노 폰트(IBM Plex
Mono latin, 30KB)는 `assets/fonts/`에 self-host, 한글 본문은 시스템 폰트.
GitHub Pages가 main 브랜치 루트를 그대로 서빙한다.

## 데이터 갱신

운영 중인 에이전트(stock-agent)가 **매매 발생 시** 해당 월의 `data/trades/*.json`에
체결 내역을 추가하고, **장 마감 후** `data/equity.json`에 일일 평가액을 추가한 뒤
commit & push 한다. 사람이 직접 편집하지 않는다.

`meta.json`의 `demo: true`는 실거래가 아닌 백테스트 샘플 데이터임을 뜻하며,
대시보드에 "샘플 데이터" 뱃지로 표시된다. 에이전트가 실기록을 push하면 `false`로 바뀐다.

### 장중 시간별 스냅샷

`.github/workflows/intraday.yml`(GitHub Actions cron)이 KST 평일 08~18시 매시
7분에 `tools/intraday_snapshot.py`를 실행한다. 외부 서버 의존 없이 **레포
데이터만으로** 동작한다: `meta.json`의 초기자본 + `trades/*.json` 체결 내역으로
포지션·현금을 재구성하고, 네이버 시세 API에서 종목 현재가와 KOSPI200 지수를
받아 `data/intraday/YYYY-MM-DD.json`에 append 후 commit & push 한다.

- KST 평일 08~18시(프리마켓~시간외 단일가) 밖이면 스스로 종료
- 직전 스냅샷과 평가액·벤치마크가 같으면 스킵 (휴장일 자동 처리)
- 일별 파일 90개 초과분은 자동 삭제 (intraday는 소모성 — 일별 확정치는 equity.json)
- 재구성 현금이 음수면 trades 오염(유령 체결 등)으로 보고 기록 없이 실패
- trades에 `fee` 필드가 없는 동안은 체결액의 1.49bp(실측)를 수수료로 추정 차감

## 로컬 미리보기

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## 데이터 스키마 (v1)

```jsonc
// equity.json
{ "schema_version": 1,
  "series": [ { "date": "2026-06-05", "value": 455887815,
                "benchmark": 1297.02, "regime": "bull" } ] }

// trades/2026-06.json
{ "schema_version": 1, "month": "2026-06",
  "trades": [ { "ts": "2026-06-05T09:00:00+09:00", "cycle_id": "2026-06-05-1",
                "ticker": "122630", "name": "KODEX 레버리지", "side": "buy",
                "qty": 120, "price": 21540.0, "amount": 2584800,
                "status": "filled", "reason": "레짐 전환 bull", "regime": "bull",
                "liquidation": false } ] }

// intraday/2026-06-12.json — 장중 시간별 스냅샷
{ "schema_version": 1, "date": "2026-06-12",
  "snapshots": [ { "ts": "2026-06-12T10:07:00+09:00", "value": 104369910,
                   "cash": 56925840, "benchmark": 1321.29,
                   "market_status": "OPEN",
                   "positions": [ { "ticker": "069500", "qty": 138,
                                    "price": 133050 } ] } ] }
```

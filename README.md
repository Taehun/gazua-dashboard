# 가즈아 (GAZUA) 대시보드

[가즈아(GAZUA)](https://github.com/Taehun/GAZUA) — 한국 주식 레짐 기반 자동매매 에이전트의
**매매 히스토리·수익률 추적 대시보드**.

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
tools/generate_demo_data.py  # 데모 데이터 재생성 (실데이터 백테스트 출력)
```

**의존성 0** — 빌드 도구·외부 라이브러리 없음 (웹폰트 제외). GitHub Pages가 main 브랜치
루트를 그대로 서빙한다.

## 데이터 갱신

운영 중인 에이전트(stock-agent)가 **매매 발생 시** 해당 월의 `data/trades/*.json`에
체결 내역을 추가하고, **장 마감 후** `data/equity.json`에 일일 평가액을 추가한 뒤
commit & push 한다. 사람이 직접 편집하지 않는다.

`meta.json`의 `demo: true`는 실거래가 아닌 백테스트 샘플 데이터임을 뜻하며,
대시보드에 "샘플 데이터" 뱃지로 표시된다. 에이전트가 실기록을 push하면 `false`로 바뀐다.

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
```

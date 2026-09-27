---
name: verify-data
description: Verify data/ JSON integrity (schema, equity/trades/intraday/briefings invariants, cash/holdings reconstruction) with tools/verify_data.py and fix violations. Use after any change to data/**, tools/intraday_snapshot.py, tools/generate_demo_data.py, or the data schema, and before committing data.
allowed-tools: [Read, Edit, Grep, Glob, Bash]
---
대시보드가 읽는 `data/` 가 스키마와 불변식을 지키는지 검증하고, 위반은 고친다.

## 절차

1. 레포 루트에서 실행:

   ```bash
   python3 tools/verify_data.py
   ```

   `PASS` 와 exit 0 이 나오면 끝. `ERROR` 가 있으면 2단계로 간다.

2. `ERROR` 마다 가리키는 `file` / `index` 를 열어서 원인을 확인한다.
   - **index ↔ 파일 불일치** (`trades/index.json` months, `briefings/index.json` dates):
     index 에 빠진 항목을 추가하거나 고아 항목을 지운다. 날짜·월은 정렬 상태로 둔다.
   - **amount ≠ qty×price**, **ts/month 불일치**, **date 필드 ≠ 파일명**: 레코드를 고친다.
     원천(에이전트 출력)이 잘못된 경우라면 추측으로 숫자를 만들지 말고 사용자에게 보고한다.
   - **재구성 현금 음수 / 보유수량 음수**: 유령 체결이나 중복 기록이 원인이다. 같은
     `ts`·`ticker`·`qty` 가 두 번 들어간 레코드를 찾아 보고한다. 실제 체결 기록을
     임의로 삭제하지 말고 사용자 확인을 받는다. 이 상태면 intraday cron 이 기록을 멈춘다.
   - **tools/*.py 를 고친 경우**: 스크립트 로직이 재구성 의미론(status 무시, qty 0 만 스킵,
     fee 없으면 1.49bp 추정)을 바꿨는지 먼저 확인한다.

3. 고친 뒤 1단계를 다시 돌린다. `PASS` 가 나올 때까지 반복하고, 같은 오류가 3회 반복되면
   멈추고 무엇이 막혔는지 보고한다.

4. 코드(스크립트)를 바꿨다면 쓰기 동작 없이 스냅샷 계산만 확인한다:

   ```bash
   python3 tools/intraday_snapshot.py --dry-run --force
   ```

   (네이버 시세 API 호출. 네트워크가 막힌 환경이면 건너뛰고 그 사실을 보고에 적는다.)

## WARN

`WARN` 은 exit 0 이다. 현재 알려진 정상 WARN:
- `benchmark 가 null`: 벤치마크 수집 실패일. 앱은 비교에서 제외하고 그린다.
- `fee 없음`: 2026-06 초기 레코드. 재구성에서 1.49bp 로 추정한다.

새 종류의 WARN 이 생겼으면 보고에 적는다. `--strict` 는 WARN 도 실패로 취급한다.

## 보고

마지막 `verify_data.py` 출력 요약(PASS/FAIL, errors/warnings 수)과 고친 파일 목록을 적는다.

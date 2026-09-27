---
name: verify-dashboard
description: Render the dashboard in headless Chromium (desktop 1440px + mobile 390px), check for JS errors, failed requests, missing KPI/chart/trade sections, NaN/undefined on screen and horizontal overflow, then inspect screenshots and fix. Use after changing index.html, assets/**, or data/ schema, and before committing UI changes.
allowed-tools: [Read, Edit, Grep, Glob, Bash]
---
대시보드를 실제 브라우저로 렌더해서 화면이 깨지지 않았는지 검증하고, 문제는 고친다.

## 절차

1. `data/` 를 바꿨다면 먼저 `/verify-data` 를 돌려 PASS 를 확인한다. 데이터가 깨진 상태의
   렌더 실패는 UI 버그가 아니다.

2. 레포 루트에서 스모크 테스트를 실행한다:

   ```bash
   NODE_PATH="$(npm root -g)" node .claude/skills/verify-dashboard/scripts/smoke.cjs /tmp/gazua-smoke
   ```

   - 레포 루트를 임시 포트의 정적 서버로 띄워 데스크톱·모바일 두 뷰포트를 검사한다.
   - `playwright` 가 없다는 메시지(exit 2)가 나오면:
     `npm i -g playwright && npx playwright install chromium`
     (Claude Code 원격 환경은 `/opt/pw-browsers/chromium` 을 자동으로 쓴다. 브라우저를 설치하지 말 것.)
   - `data/intraday/*.json` 404 는 앱이 최근 파일을 탐색하는 정상 동작이라 무시된다.

3. 결과가 `FAIL` 이면 항목별로 원인을 찾아 고친다:
   - `JS 예외` / `console.error`: `assets/app.js` 의 해당 경로.
   - `HTTP 4xx`: 경로 오타, 파일 누락. 링크는 상대경로여야 한다(GitHub Pages 하위 경로 서빙).
   - `NaN/undefined/Infinity 노출`: 포매터(`fmtPct`, `fmtKRW` 등)에 들어가는 값을 거슬러
     올라가 확인한다. null 벤치마크처럼 데이터에 결측이 있는 경우를 가드한다.
   - `가로 스크롤 발생`: 모바일 390px 에서 폭을 넘는 요소. 테이블은 `.table-wrap` 안에서만
     가로 스크롤해야 한다.
   - 섹션 없음(KPI·차트·매매 행): 렌더 함수가 조기 종료했는지, 템플릿 id 가 바뀌었는지 확인한다.

4. `PASS` 여도 스크린샷(`desktop.png`, `mobile.png`)을 Read 로 열어 직접 본다. 스크립트가
   못 잡는 것: 겹친 텍스트, 잘린 라벨, 빈 차트 영역, 색 규칙 위반(한국 증시 컨벤션: 상승=빨강,
   하락=파랑), 바꾼 부분이 의도대로 보이는지.

5. 고친 뒤 2단계부터 다시 돌린다. PASS 이고 스크린샷에 문제가 없을 때 끝낸다. 같은 실패가
   3회 반복되면 멈추고 무엇이 막혔는지 보고한다.

## 보고

뷰포트별 PASS/FAIL, 고친 파일, 스크린샷에서 확인한 사항(한두 줄)을 적는다.

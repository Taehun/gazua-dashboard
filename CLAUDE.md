# CLAUDE.md

의존성 0 정적 대시보드 (GitHub Pages, main 루트 서빙). 구조·스키마는 README.md 참고.

## 작업 완료 전 검증 (필수)

변경을 마쳤다고 보고하기 전에 해당 검증 스킬을 돌려 PASS 를 확인한다.

| 바꾼 것 | 돌릴 스킬 |
| --- | --- |
| `data/**`, `tools/*.py`, 데이터 스키마 | `/verify-data` |
| `index.html`, `assets/**`, 데이터 스키마 | `/verify-dashboard` (data 도 바꿨으면 `/verify-data` 먼저) |

- 빌드 도구·npm 의존성·외부 라이브러리를 레포에 추가하지 않는다. 검증용 playwright 는 전역 설치로만 쓴다.
- `data/` 는 에이전트(stock-agent)와 GitHub Actions 가 쓴다. 체결 기록을 추측으로 만들거나 지우지 않는다.

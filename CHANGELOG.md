# 변경 내역

## 1.1.0 — 2026-11-02

- GitHub 공개판: Claude Code 플러그인 마켓플레이스 구조(`/plugin marketplace add` → `/plugin install`)
- 사무실 라이브: 3D 사무실(claude-3d-frog-office, 따로 설치하는 선택 도구)이 없으면 「3D로 보기」 대신 「3D 사무실 설치 안내」 단추와 설명을 보여 줌. 설치했지만 꺼져 있으면 단추를 숨김
- 새 판으로 바꾼 뒤 `start` 하면 예전 판 서버를 끄고 새 판으로 다시 켬(`/api/health` 에 판 번호)
- A4 리포트 창의 'PDF 바로 저장' 폴더 안내를 실제 저장 위치로(`~/.agent-mission-control/reports`)
- 가상 데이터로 구경하기(`npm run demo`), README 화면 사진 만들기(`tools/screenshots.mjs`)
- 자동 시험: Windows·macOS·Linux × Node.js 18·24 (GitHub Actions)

## 1.0.0 — 2026-11-02

- 첫 스킬 묶음: 관제판(핵심 숫자·비용 흐름·실시간 활동·직원 카드·최근 작업·스킬 순위), 워크플로 지도와 단계 타임라인(트레이스), 스킬 DB(설치된 스킬 또는 SkillDB 엑셀), 사무실 라이브
- 🔔 예산·이상 알림(월 예산 단계·월말 초과 예상·직원별 예산·비싼 작업·멈춘 작업·갑자기 많이 쓴 날), 바탕화면 알림
- 📄 A4 리포트(인쇄·PDF 바로 저장), 💡 운영 제언 9가지 규칙
- 조작 도구 `ctl.mjs`(start·status·staff·advice·alerts·budget·report·export-skills·skills·model·setup·doctor), 처음 설정 `setup.mjs`
- 설정·캐시·리포트는 `~/.agent-mission-control` 에 저장(새 판으로 바꿔도 남음)

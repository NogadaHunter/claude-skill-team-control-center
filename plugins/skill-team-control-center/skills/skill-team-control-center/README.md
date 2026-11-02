# Claude Skill Team Control Center (스킬)

Claude Code에 만들어 둔 **스킬팀(서브에이전트 직원과 스킬)**의 현황을 한 화면에서 보고 조작하는 로컬 대시보드예요.
Claude Code 스킬로 설치하면 "스킬팀 현황 알려줘", "리포트 PDF로 저장해줘"처럼 말로 부릴 수 있어요.

- 직원별 작업 건수·토큰·**API 환산 비용**, 지금 일하는 직원과 하는 일(2초마다 갱신)
- 워크플로 지도(사용자 → 팀장 → 직원 → 스킬), 실행마다 **단계 타임라인**(응답·도구별 걸린 시간·토큰·비용)
- 🔔 **예산·이상 알림**(월 예산 단계, 월말 초과 예상, 비싼 작업, 멈춘 작업, 갑자기 많이 쓴 날) — 바탕화면 알림도
- **스킬 사용 현황**(설치된 스킬 또는 스킬 DB 엑셀과 짝지어), 엑셀로 내보내기
- 📄 **A4 리포트** — 인쇄하거나 PDF로 바로 저장
- 💡 **운영 제언** — 기록을 보고 "그래서 무엇을 하면 좋은가"(근거 숫자·실행 방법·기대 효과)

## 준비물

- Claude Code (Windows · macOS · Linux)
- **Node.js 18 이상** — https://nodejs.org 의 LTS
- (선택) Chrome 또는 Edge — 독립 창으로 열기와 'PDF 바로 저장'에 써요. 없으면 기본 브라우저로 열고, PDF는 인쇄 창에서 저장해요.
- (선택) `~/.claude/agents/`에 직원(서브에이전트) `.md` — 없어도 세션·스킬 사용은 보여요.

## 설치

**A. Claude Code에게 맡기기** — 이 `.skill`(zip) 파일을 받아 두고 Claude Code에서:

> 이 파일을 내 Claude Code 스킬로 설치해줘: `<받은 파일 경로>`

**B. 직접 풀기** — zip을 풀어 `skill-team-control-center` 폴더를 통째로 아래에 넣어요.

- Windows: `C:\Users\<나>\.claude\skills\skill-team-control-center\`
- macOS·Linux: `~/.claude/skills/skill-team-control-center/`

그다음 Claude Code를 **새로 시작**하고 이렇게 말하면 처음 설정부터 해 줘요.

> 스킬팀 관제판 설치하고 열어줘

## 쓰는 법

| 이렇게 말하면 | 하는 일 |
|---|---|
| 스킬팀 현황 알려줘 | 비용·직원·이번 달 예산·지금 상태·알림·우선 제언 요약 |
| 관제판 열어줘 | 대시보드 창 열기(http://127.0.0.1:4790) |
| 운영 제언 알려줘 | 더 잘 운영하기 위한 제언 전부 |
| 월 예산 300달러로 정해줘 | 예산·알림 기준 저장 |
| 이번 달 리포트 PDF로 저장해줘 | A4 리포트 PDF 저장 후 경로 안내 |
| 스킬 사용 현황 엑셀로 줘 | 엑셀 파일 저장 |
| 보고서팀 직원을 Sonnet으로 바꿔줘 | 직원 `.md`의 `model` 바꾸기(확인 후, 새 세션부터) |

터미널에서 직접 쓸 수도 있어요: `node app/scripts/ctl.mjs help`
Windows에서는 `app\Claude-Skill-Team-Control-Center.cmd`, macOS에서는 `app/start.command`를 두 번 눌러도 켜져요.

## 데이터와 개인정보

- 이 PC의 Claude Code 기록(`~/.claude/projects`)과 직원 파일(`~/.claude/agents`)을 **읽기만** 해요. 직원 모델 바꾸기는 요청했을 때만 그 파일의 `model` 한 줄을 고쳐요.
- 서버는 이 컴퓨터(127.0.0.1)에서만 열리고 외부로 아무것도 보내지 않아요.
- 명령(Bash·PowerShell) 원문은 비밀값이 섞일 수 있어 화면에 보여 주지 않아요.
- 비용은 Claude API 공식 단가로 계산한 **환산값**이에요(구독 요금제의 실제 청구액이 아님). 단가는 `app/config/pricing.json`.
- claude.ai 웹·앱에서 쓴 것은 이 PC 기록에 없어서 빠져요.

## 설정·데이터가 있는 곳

`~/.agent-mission-control/`

| 파일 | 내용 |
|---|---|
| `config/profiles.json` | 부르는 이름(owner), 직원 팀 이름·색·목적·워크플로, 팀장 세션 폴더 — 자유롭게 고쳐요 |
| `config/budget.json` | 월 예산·알림 기준(화면의 🔔에서 고침) |
| `config/skilldb.json` | (선택) 스킬 DB 엑셀 위치 |
| `reports/` | 'PDF 바로 저장'한 리포트·내보낸 엑셀 |
| `cache.json` · `alerts.json` · `server.log` | 집계 캐시·알림 읽음 기록·서버 로그 |

## 지우기

`ctl.mjs stop`으로 서버를 끄고, 스킬 폴더와 `~/.agent-mission-control` 폴더를 지우면 끝이에요.

# skill-team-control-center

Claude Code 스킬팀(서브에이전트 직원과 스킬)의 **관제 대시보드** 플러그인이에요.
직원별 작업 건수·토큰·API 환산 비용, 실시간 상태, 워크플로 지도와 단계 타임라인, 예산·이상 알림, 스킬 사용 현황, A4 리포트 PDF, 운영 제언을 한 화면에서 보고 말로 조작해요.

## 설치

```text
/plugin marketplace add NogadaHunter/claude-skill-team-control-center
/plugin install skill-team-control-center@peopleware-skill-team
```

새 Claude Code 세션에서: `스킬팀 관제판 설치하고 열어줘`

## 쓰는 법

- `스킬팀 현황 알려줘` · `관제판 열어줘` · `운영 제언 알려줘`
- `월 예산 300달러로 정해줘` · `이번 달 리포트 PDF로 저장해줘` · `스킬 사용 현황 엑셀로 줘`

## 필요한 것

Node.js 18 이상(의존성 없음). 이 PC의 Claude Code 기록을 읽기만 하고 외부로 아무것도 보내지 않아요.

자세한 설명: https://github.com/NogadaHunter/claude-skill-team-control-center

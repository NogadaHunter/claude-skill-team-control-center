# GitHub에 올리는 법 (저장소 주인용)

이 저장소는 개발 폴더에서 빌드해 만들어요. **이 저장소의 파일을 직접 고치지 말고** 개발 폴더에서 고친 뒤 다시 빌드하세요.

## 0. 올리기 전에

```bash
npm test         # 시험
npm run check    # 구조 점검 (✔ 통과가 나와야 해요)
claude plugin validate .
```

## 1. 처음 올리기

1. github.com → **+ → New repository** → 이름 `claude-skill-team-control-center`, **Public**, README·LICENSE 추가는 체크하지 않기 → **Create repository**
2. git 명령으로 올려요. 웹에서 끌어다 놓으면 `.claude-plugin`·`.github` 처럼 점(.)으로 시작하는 폴더가 빠지기 쉬워요.

```bash
git init
git add .
git update-index --chmod=+x plugins/skill-team-control-center/skills/skill-team-control-center/app/start.command
git commit -m "첫 공개 (v1.1.0)"
git branch -M main
git remote add origin https://github.com/NogadaHunter/claude-skill-team-control-center.git
git push -u origin main
```

## 2. 올린 뒤

- **Actions** 탭에서 `test`(Windows·macOS·Linux × Node 18·24)가 모두 초록색인지 확인해요.
- 저장소 오른쪽 **About** 톱니바퀴 → Description: `Claude Code 스킬팀(서브에이전트·스킬) 관제 대시보드 — 현황·토큰·비용·알림·A4 리포트`, Topics: `claude-code`, `claude-code-plugin`, `claude-skills`, `subagents`, `dashboard`
- **Releases → Create a new release** → 태그 `v1.1.0` → `dist/skill-team-control-center.skill` 첨부
- 설치 시험: Claude Code에서 `/plugin marketplace add NogadaHunter/claude-skill-team-control-center` → `/plugin install skill-team-control-center@peopleware-skill-team` → 새 세션에서 "스킬팀 관제판 설치하고 열어줘"

## 3. 고칠 때

1. 개발 폴더에서 고치고 `package.json` 의 `version` 을 올린다(안 올리면 이미 설치한 사람에게 업데이트가 안 가요)
2. `CHANGELOG.md` 에 적는다
3. 개발 폴더에서 `npm test` → `npm run build:github` (이 저장소 폴더를 새로 채워요. `.git` 은 그대로)
4. 이 폴더에서 `npm run check` → `git add -A` → `git commit` → `git push`

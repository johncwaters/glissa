<!-- Parent: ../AGENTS.md -->

# Plan Review

- Never parse plan HTML, because plan text crosses an untrusted boundary (`tests/frontend-plan-markdown.test.ts`).
- Keep only `http:` and `https:` link targets, because other schemes can execute or escape the dashboard trust boundary (`tests/frontend-plan-markdown.test.ts`).
- Mount the plan as the session card's second face, because Focus and phone must share one live session surface (`tests/frontend-plan-face.test.ts`).

<!-- Parent: ../AGENTS.md -->

# Plan Review

- Never parse plan HTML, because plan text crosses an untrusted boundary (`tests/frontend-plan-markdown.test.ts`).
- Keep only `http:` and `https:` link targets, because other schemes can execute or escape the dashboard trust boundary (`tests/frontend-plan-markdown.test.ts`).
- Mount the plan as the session card's second face, because Focus and phone must share one live session surface (`tests/frontend-plan-face.test.ts`).
- Action labels are CONSTANT and progress lives in the status text beside them, or the control moves under the thumb reaching for it (`tests/frontend-plan-view.test.ts`).
- A decision is offered only on the OPEN revision with its body on screen, and a reopen moves the face there, or the bar approves bytes nobody read and the server refuses every click (`tests/frontend-plan-view.test.ts`).
- `session-plan-changed` is REFRESHABLE, so backpressure can drop it: a VISIBLE face re-pulls when it is shown or the socket reconnects, carrying its live selection, since a hidden face re-pulls on show anyway and one reconnect must not fan a plan body out to every card (`tests/frontend-plan-face.test.ts`).

// Pure aggregate-status computation. Given session-state counts, return the
// header text, severity, and alert count. The tally over sessionUIs and the DOM
// write (aggregateEl + document.title) live in lifecycle.js
// (updateAggregateStatus); this is the testable precedence ladder.

export function computeAggregate(counts) {
  const { waiting, failed, done, complete, dormant, total } = counts;
  const pl = (n) => (n > 1 ? 's' : '');

  // COMPLETE (finished-ok) and DONE (exited) are both terminal. They share the
  // "exited" bucket so a finished session neither raises its own navbar banner
  // nor counts toward the title-badge alert - only WAITING/FAILED nag.
  const exited = done + complete;
  const alertCount = waiting + failed;

  // The steady "N running" state is deliberately NOT surfaced: an always-on
  // active-session counter is noise that provides no actionable signal. The banner
  // only speaks for states worth acting on (needs-input, failed) or terminal
  // roll-ups (all exited / all dormant); an active mix renders blank (hidden).
  if (waiting > 0) return { text: `${waiting} session${pl(waiting)} need input`, severity: 'warning', alertCount };
  if (failed > 0) return { text: `${failed} session${pl(failed)} failed`, severity: 'critical', alertCount };
  if (total > 0 && exited === total) return { text: 'All sessions exited', severity: 'done', alertCount };
  if (total > 0 && dormant === total) return { text: `${dormant} session${pl(dormant)} dormant`, severity: '', alertCount };
  return { text: '', severity: '', alertCount };
}

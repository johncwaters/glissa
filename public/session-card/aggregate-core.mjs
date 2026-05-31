// Pure aggregate-status computation. Given session-state counts, return the
// header text, severity, and alert count. The tally over sessionUIs and the DOM
// write (aggregateEl + document.title) live in lifecycle.js
// (updateAggregateStatus); this is the testable precedence ladder.

export function computeAggregate(counts) {
  const { waiting, failed, done, complete, dormant, total } = counts;
  const pl = (n) => (n > 1 ? 's' : '');

  let text = '';
  let severity = '';

  if (waiting > 0) {
    text = `${waiting} session${pl(waiting)} need input`;
    severity = 'warning';
  } else if (failed > 0) {
    text = `${failed} session${pl(failed)} failed`;
    severity = 'critical';
  } else if (complete > 0) {
    text = `${complete} session${pl(complete)} finished`;
    severity = 'done';
  } else if (total > 0 && done === total) {
    text = 'All sessions exited';
    severity = 'done';
  } else if (total > 0 && dormant === total) {
    text = `${dormant} session${pl(dormant)} dormant`;
    severity = '';
  } else if (total > 0) {
    const active = total - done - dormant;
    text = `${active} session${pl(active)} running`;
    severity = 'success';
  }

  const alertCount = waiting + failed + complete;
  return { text, severity, alertCount };
}

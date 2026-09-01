export interface AggregateCounts {
  waiting: number;
  failed: number;
  done: number;
  complete: number;
  dormant: number;
  total: number;
}

export function computeAggregate(counts: AggregateCounts) {
  const { waiting, failed, done, complete, dormant, total } = counts;
  const pl = (n: number) => (n > 1 ? 's' : '');

  const exited = done + complete;
  const alertCount = waiting + failed;

  if (waiting > 0) return { text: `${waiting} session${pl(waiting)} need input`, severity: 'warning', alertCount };
  if (failed > 0) return { text: `${failed} session${pl(failed)} failed`, severity: 'critical', alertCount };
  if (total > 0 && exited === total) return { text: 'All sessions exited', severity: 'done', alertCount };
  if (total > 0 && dormant === total) return { text: `${dormant} session${pl(dormant)} dormant`, severity: '', alertCount };
  return { text: '', severity: '', alertCount };
}

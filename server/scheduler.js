'use strict';

// In-process scheduler for team runs. No external dependency.
//
// Timezone math uses Intl: Intl can FORMAT an instant in a timezone but cannot PARSE a zoned
// wall-clock back to an instant, so we offset-solve (compute the tz offset at a guess instant,
// then correct). DST semantics: a non-existent local time resolves to the next valid instant; a
// duplicated local time resolves to the first occurrence. The configured 05:00 fire avoids the
// 02:00-03:00 spring-forward gap in practice, but the algorithm is correct generally.
// See .omc/plans/marketing-team-pipeline.md section 3.11.

const MAX_TIMEOUT_MS = 2 ** 31 - 1; // setTimeout 32-bit ceiling
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Offset (wall-clock - UTC) in ms that `tz` applies at instant `date`.
function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// Convert a wall-clock (y, mo[0-11], d, h, mi) in `tz` to the UTC instant in ms.
function wallClockToInstant(y, mo, d, h, mi, tz) {
  const naiveUTC = Date.UTC(y, mo, d, h, mi, 0);
  let off = tzOffsetMs(new Date(naiveUTC), tz);
  let instant = naiveUTC - off;
  // Refine once: at a DST edge the offset at the naive guess differs from the offset at the instant.
  off = tzOffsetMs(new Date(instant), tz);
  instant = naiveUTC - off;
  return instant;
}

// The tz-local calendar date at instant `date`.
function tzCalendarDate(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day };
}

// Next UTC instant (ms) strictly after `fromMs` matching schedule {days:[tokens], time:'HH:MM', tz}.
// Returns null if the schedule names no days. Walks tz CALENDAR dates (not 24h hops) so DST-short/
// long days never skip or double a day.
function computeNextFire(schedule, fromMs = Date.now()) {
  const { days, time, tz } = schedule || {};
  const allowed = new Set((days || []).map((d) => String(d).toLowerCase().slice(0, 3)));
  if (allowed.size === 0) return null;
  const [hh, mm] = String(time).split(':').map(Number);
  const base = tzCalendarDate(new Date(fromMs), tz);
  for (let i = 0; i < 9; i += 1) {
    const cal = new Date(Date.UTC(base.year, base.month - 1, base.day + i));
    const weekday = WEEKDAYS[cal.getUTCDay()];
    if (!allowed.has(weekday)) continue;
    const instant = wallClockToInstant(
      cal.getUTCFullYear(),
      cal.getUTCMonth(),
      cal.getUTCDate(),
      hh,
      mm,
      tz,
    );
    if (instant > fromMs) return instant;
  }
  return null;
}

// Create a scheduler that arms a single timer for the next fire and re-arms after each fire.
// Dependencies (clock + timer + compute) are injectable for deterministic tests.
function createScheduler(opts = {}) {
  const compute = opts.computeNextFire || computeNextFire;
  const setT = opts.setTimeoutFn || setTimeout;
  const clearT = opts.clearTimeoutFn || clearTimeout;
  const nowFn = opts.now || Date.now;
  const onFire = opts.onFire || (() => {});

  let timer = null;
  let current = null; // { schedule, key }

  function unrefIf(t) {
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  function scheduleNext() {
    if (!current) return;
    const next = compute(current.schedule, nowFn());
    if (next == null) return;
    let delay = next - nowFn();
    if (delay < 0) delay = 0;
    if (delay > MAX_TIMEOUT_MS) {
      // Far-future: re-check within a day rather than overflow the 32-bit timer.
      timer = unrefIf(setT(scheduleNext, DAY_MS));
      return;
    }
    timer = unrefIf(setT(() => {
      timer = null;
      try {
        onFire(current.key, current.schedule);
      } finally {
        scheduleNext();
      }
    }, delay));
  }

  function arm(schedule, key) {
    disarm();
    current = { schedule, key };
    scheduleNext();
  }

  function disarm() {
    if (timer) {
      clearT(timer);
      timer = null;
    }
    current = null;
  }

  return { arm, disarm, scheduleNext };
}

module.exports = {
  computeNextFire,
  createScheduler,
};

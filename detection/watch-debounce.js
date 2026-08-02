'use strict';

// Shared debounce-into-trailing-call + stop lifecycle for the single-directory fs.watch
// listeners in this folder (worktree-watch.js, integration-ref-watch.js). Both watch one
// directory and want at most one onChange() per write burst, plus a stop() that clears the
// timer and closes the watcher (idempotent, safe if the watcher was never started).
//
// The caller owns start()/the fs.watch call itself (the two watchers resolve their target
// directory differently), and assigns the resulting watcher onto the returned `watcher`
// property so stop() can close it.
function createWatchDebounce({ onChange, debounceMs }) {
  let watcher = null;
  let timer = null;
  let stopped = false;

  function fire() {
    if (timer) return; // coalesce a write burst into one trailing call
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      try { onChange(); } catch { /* a consumer error must not kill the watcher */ }
    }, debounceMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (watcher) {
      try { watcher.close(); } catch { /* already closed */ }
      watcher = null;
    }
  }

  return {
    fire,
    stop,
    get watcher() { return watcher; },
    set watcher(w) { watcher = w; },
    get stopped() { return stopped; },
  };
}

module.exports = { createWatchDebounce };

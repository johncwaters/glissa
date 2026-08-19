'use strict';

// Loads a wiring module with session/sessions swapped for a constructor-recording fake, so lane
// tests can pin the exact Session options a wiring builds without spawning anything.

const path = require('node:path');

// modulePath is relative to tests/ (the callers' own directory), not to this helpers/ subdir.
const TESTS_DIR = path.resolve(__dirname, '..');

function withFakeSession(modulePath, fn) {
  const sessionPath = require.resolve('../../session/sessions');
  const wiringPath = require.resolve(modulePath, { paths: [TESTS_DIR] });
  const previousSession = require.cache[sessionPath];
  const previousWiring = require.cache[wiringPath];
  const constructed = [];
  class FakeSession {
    constructor(options) {
      this.options = options;
      constructed.push(options);
    }

    on() {
      return this;
    }

    destroy() {}
  }

  delete require.cache[wiringPath];
  require.cache[sessionPath] = {
    id: sessionPath,
    filename: sessionPath,
    loaded: true,
    exports: { Session: FakeSession },
  };
  try {
    return fn(require(wiringPath), constructed);
  } finally {
    delete require.cache[wiringPath];
    if (previousWiring) require.cache[wiringPath] = previousWiring;
    if (previousSession) require.cache[sessionPath] = previousSession;
    if (!previousSession) delete require.cache[sessionPath];
  }
}

module.exports = { withFakeSession };

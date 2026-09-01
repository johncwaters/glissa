'use strict';

// A recording stand-in for the Session constructor, handed to a wiring through its makeSession seam,
// so lane tests can pin the exact Session options a wiring builds without spawning anything.

function recordingSessionFactory() {
  const constructed = [];
  const makeSession = (options) => {
    constructed.push(options);
    return {
      options,
      on() { return this; },
      destroy() {},
    };
  };
  return { makeSession, constructed };
}

module.exports = { recordingSessionFactory };

'use strict';

function buildTitleSequence(title) {
  return `\x1b]0;${title}\x07`;
}

function buildTitleClearSequence() {
  return buildTitleSequence('');
}

module.exports = { buildTitleSequence, buildTitleClearSequence };

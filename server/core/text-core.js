'use strict';

function firstLine(text) {
  return String(text == null ? '' : text).split(/\r?\n/)[0].trim();
}

module.exports = { firstLine };

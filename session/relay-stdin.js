'use strict';

function readStdin(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    };
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', finish);
    stream.on('error', finish);
    stream.on('close', finish);
  });
}

module.exports = { readStdin };

/**
 * Spike (a) - Test piped stdio behavior of `claude` CLI
 * Spawns claude with piped stdio and logs chunk behavior.
 */
const { spawn } = require('child_process');

const TIMEOUT_MS = 20000;
const chunks = { stdout: [], stderr: [] };

console.log('=== Piped stdio test ===');
console.log(`Starting claude with piped stdio at ${new Date().toISOString()}`);

const proc = spawn('claude', ['-p', 'what is 2+2? reply with just the number'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
});

proc.stdout.on('data', (data) => {
  const now = Date.now();
  const text = data.toString();
  const hasAnsi = /\x1b\[/.test(text);
  chunks.stdout.push({ time: now, size: data.length, hasAnsi, text });
  console.log(`[stdout] size=${data.length} hasAnsi=${hasAnsi} text=${JSON.stringify(text.substring(0, 200))}`);
});

proc.stderr.on('data', (data) => {
  const now = Date.now();
  const text = data.toString();
  const hasAnsi = /\x1b\[/.test(text);
  chunks.stderr.push({ time: now, size: data.length, hasAnsi, text });
  console.log(`[stderr] size=${data.length} hasAnsi=${hasAnsi} text=${JSON.stringify(text.substring(0, 200))}`);
});

proc.on('close', (code) => {
  console.log(`\nProcess exited with code ${code}`);
  printSummary();
});

proc.on('error', (err) => {
  console.error('Spawn error:', err.message);
});

setTimeout(() => {
  console.log('\n=== TIMEOUT - killing process ===');
  proc.kill('SIGTERM');
  setTimeout(() => printSummary(), 1000);
}, TIMEOUT_MS);

function printSummary() {
  console.log('\n=== SUMMARY ===');
  console.log(`stdout chunks: ${chunks.stdout.length}`);
  console.log(`stderr chunks: ${chunks.stderr.length}`);
  console.log(`stdout total bytes: ${chunks.stdout.reduce((s, c) => s + c.size, 0)}`);
  console.log(`stderr total bytes: ${chunks.stderr.reduce((s, c) => s + c.size, 0)}`);
  console.log(`Any ANSI in stdout: ${chunks.stdout.some(c => c.hasAnsi)}`);
  console.log(`Any ANSI in stderr: ${chunks.stderr.some(c => c.hasAnsi)}`);

  if (chunks.stdout.length > 1) {
    const times = chunks.stdout.map(c => c.time);
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i-1]);
    console.log(`stdout chunk gaps (ms): ${gaps.join(', ')}`);
  }
}

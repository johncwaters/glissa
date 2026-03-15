/**
 * Spike (b) - Test --output-format stream-json behavior
 * Tests promising flags for clean parseable output.
 */
const { spawn } = require('child_process');

const TIMEOUT_MS = 20000;
const chunks = [];

console.log('=== stream-json output format test ===');

const proc = spawn('claude', [
  '-p',
  '--output-format', 'stream-json',
  'what is 2+2? reply with just the number'
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
});

proc.stdout.on('data', (data) => {
  const text = data.toString();
  chunks.push(text);
  console.log(`[stdout] size=${data.length} text=${JSON.stringify(text.substring(0, 500))}`);
});

proc.stderr.on('data', (data) => {
  console.log(`[stderr] ${data.toString().substring(0, 200)}`);
});

proc.on('close', (code) => {
  console.log(`\nProcess exited with code ${code}`);
  console.log('\n=== Attempting JSON parse of each line ===');
  const allText = chunks.join('');
  const lines = allText.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      console.log(`PARSED: type=${obj.type} keys=${Object.keys(obj).join(',')}`);
    } catch {
      console.log(`NOT JSON: ${line.substring(0, 100)}`);
    }
  }
});

proc.on('error', (err) => {
  console.error('Spawn error:', err.message);
});

setTimeout(() => {
  console.log('\n=== TIMEOUT ===');
  proc.kill('SIGTERM');
}, TIMEOUT_MS);

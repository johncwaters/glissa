/**
 * Spike (b) - Test --output-format json behavior
 * Single JSON result output.
 */
const { spawn } = require('child_process');

const TIMEOUT_MS = 20000;
const chunks = [];

console.log('=== json output format test ===');

const proc = spawn('claude', [
  '-p',
  '--output-format', 'json',
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
  const allText = chunks.join('');
  console.log('\n=== Full output ===');
  console.log(allText);
  try {
    const obj = JSON.parse(allText);
    console.log('\n=== Parsed JSON ===');
    console.log('Keys:', Object.keys(obj));
    console.log('Stringified:', JSON.stringify(obj, null, 2).substring(0, 1000));
  } catch (e) {
    console.log('Failed to parse as JSON:', e.message);
  }
});

proc.on('error', (err) => {
  console.error('Spawn error:', err.message);
});

setTimeout(() => {
  console.log('\n=== TIMEOUT ===');
  proc.kill('SIGTERM');
}, TIMEOUT_MS);

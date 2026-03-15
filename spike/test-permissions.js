/**
 * Spike (c) - Test --dangerously-skip-permissions and --permission-mode flags
 * Compare output behavior with and without permission bypassing.
 */
const { spawn } = require('child_process');

const TIMEOUT_MS = 20000;

function runTest(label, args) {
  return new Promise((resolve) => {
    const chunks = { stdout: [], stderr: [] };
    console.log(`\n=== Test: ${label} ===`);
    console.log(`Args: ${args.join(' ')}`);

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    proc.stdout.on('data', (data) => {
      chunks.stdout.push(data.toString());
      console.log(`[${label} stdout] ${data.toString().substring(0, 200)}`);
    });

    proc.stderr.on('data', (data) => {
      chunks.stderr.push(data.toString());
      console.log(`[${label} stderr] ${data.toString().substring(0, 200)}`);
    });

    proc.on('close', (code) => {
      console.log(`[${label}] exited code=${code}`);
      resolve({ label, code, stdout: chunks.stdout.join(''), stderr: chunks.stderr.join('') });
    });

    proc.on('error', (err) => {
      console.error(`[${label}] error: ${err.message}`);
      resolve({ label, code: -1, stdout: '', stderr: err.message });
    });

    setTimeout(() => proc.kill('SIGTERM'), TIMEOUT_MS);
  });
}

async function main() {
  // Test 1: print mode with dangerously-skip-permissions
  const r1 = await runTest('skip-perms', [
    '-p',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    'what is 2+2? reply with just the number'
  ]);

  // Test 2: print mode with permission-mode=bypassPermissions
  const r2 = await runTest('bypass-mode', [
    '-p',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json',
    'what is 2+2? reply with just the number'
  ]);

  console.log('\n=== COMPARISON ===');
  console.log(`skip-perms: code=${r1.code} stdout_len=${r1.stdout.length} stderr_len=${r1.stderr.length}`);
  console.log(`bypass-mode: code=${r2.code} stdout_len=${r2.stdout.length} stderr_len=${r2.stderr.length}`);
}

main().catch(console.error);

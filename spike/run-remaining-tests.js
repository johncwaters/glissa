/**
 * Additional tests: stream-json with --verbose, and input-format stream-json
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
delete cleanEnv.CLAUDE_CODE_SSE_PORT;
delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

const RESULTS_FILE = path.join(__dirname, 'results2.txt');
const results = [];

function log(msg) {
  console.log(msg);
  results.push(msg);
}

function saveResults() {
  fs.writeFileSync(RESULTS_FILE, results.join('\n'), 'utf8');
}

function runClaude(label, args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const chunks = { stdout: [], stderr: [] };
    const startTime = Date.now();

    log(`\n${'='.repeat(60)}`);
    log(`TEST: ${label}`);
    log(`ARGS: claude ${args.join(' ')}`);
    log(`${'='.repeat(60)}`);

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
      shell: true,
    });

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      const hasAnsi = /\x1b\[/.test(text);
      chunks.stdout.push({ size: data.length, hasAnsi, text, elapsed: Date.now() - startTime });
      log(`  [stdout] elapsed=${Date.now() - startTime}ms size=${data.length} hasAnsi=${hasAnsi}`);
      // For stream-json, show each line
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          log(`  [json-event] type=${obj.type} ${obj.subtype ? 'subtype='+obj.subtype : ''} keys=${Object.keys(obj).join(',')}`);
          if (obj.type === 'assistant' && obj.message) {
            log(`  [json-event]   message.role=${obj.message.role} content_blocks=${obj.message.content?.length || 0}`);
          }
          if (obj.type === 'result') {
            log(`  [json-event]   result_preview=${JSON.stringify(obj.result?.substring?.(0, 100) || obj.result)}`);
            log(`  [json-event]   session_id=${obj.session_id}`);
            log(`  [json-event]   cost=${obj.total_cost_usd}`);
            log(`  [json-event]   stop_reason=${obj.stop_reason}`);
          }
        } catch {
          log(`  [raw-line] ${line.substring(0, 200)}`);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      chunks.stderr.push({ text });
      log(`  [stderr] ${text.substring(0, 200)}`);
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      log(`  [TIMEOUT after ${timeoutMs}ms]`);
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      log(`  [exit] code=${code} elapsed=${Date.now() - startTime}ms killed=${killed}`);
      log(`  [summary] stdout_chunks=${chunks.stdout.length} stderr_chunks=${chunks.stderr.length}`);
      log(`  [summary] stdout_bytes=${chunks.stdout.reduce((s, c) => s + c.size, 0)}`);
      log(`  [summary] any_ansi_stdout=${chunks.stdout.some(c => c.hasAnsi)}`);
      resolve();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      log(`  [error] ${err.message}`);
      resolve();
    });
  });
}

async function main() {
  log('SPIKE: Additional Tests');
  log(`Date: ${new Date().toISOString()}`);

  // Test: stream-json with --verbose (required per error message)
  await runClaude('stream-json + verbose', [
    '-p', '--verbose', '--output-format', 'stream-json',
    'what is 2+2? reply with just the number'
  ]);

  // Test: stream-json + verbose + skip-permissions
  await runClaude('stream-json + verbose + skip-perms', [
    '-p', '--verbose', '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    'what is 2+2? reply with just the number'
  ]);

  log('\n' + '='.repeat(60));
  log('ADDITIONAL TESTS COMPLETE');
  log('='.repeat(60));

  saveResults();
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  saveResults();
});

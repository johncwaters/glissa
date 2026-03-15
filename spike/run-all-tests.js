/**
 * Combined spike test - runs all investigations and writes results to file.
 * Handles env var cleanup internally.
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Clean env - remove claude nesting detection vars
const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
delete cleanEnv.CLAUDE_CODE_SSE_PORT;
delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

const RESULTS_FILE = path.join(__dirname, 'results.txt');
const results = [];

function log(msg) {
  console.log(msg);
  results.push(msg);
}

function saveResults() {
  fs.writeFileSync(RESULTS_FILE, results.join('\n'), 'utf8');
  console.log(`\nResults saved to ${RESULTS_FILE}`);
}

function runClaude(label, args, timeoutMs = 30000) {
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
      log(`  [stdout] content: ${JSON.stringify(text.substring(0, 300))}`);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      const hasAnsi = /\x1b\[/.test(text);
      chunks.stderr.push({ size: data.length, hasAnsi, text, elapsed: Date.now() - startTime });
      log(`  [stderr] elapsed=${Date.now() - startTime}ms size=${data.length} hasAnsi=${hasAnsi}`);
      log(`  [stderr] content: ${JSON.stringify(text.substring(0, 300))}`);
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      log(`  [TIMEOUT after ${timeoutMs}ms - killing]`);
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - startTime;
      log(`  [exit] code=${code} elapsed=${elapsed}ms killed=${killed}`);
      log(`  [summary] stdout_chunks=${chunks.stdout.length} stderr_chunks=${chunks.stderr.length}`);
      log(`  [summary] stdout_bytes=${chunks.stdout.reduce((s, c) => s + c.size, 0)}`);
      log(`  [summary] stderr_bytes=${chunks.stderr.reduce((s, c) => s + c.size, 0)}`);
      log(`  [summary] any_ansi_stdout=${chunks.stdout.some(c => c.hasAnsi)}`);
      log(`  [summary] any_ansi_stderr=${chunks.stderr.some(c => c.hasAnsi)}`);

      if (chunks.stdout.length > 1) {
        const gaps = [];
        for (let i = 1; i < chunks.stdout.length; i++) {
          gaps.push(chunks.stdout[i].elapsed - chunks.stdout[i-1].elapsed);
        }
        log(`  [summary] stdout_chunk_gaps_ms=${gaps.join(', ')}`);
      }

      // Try JSON parse of full stdout
      const fullStdout = chunks.stdout.map(c => c.text).join('');
      try {
        const parsed = JSON.parse(fullStdout);
        log(`  [json] Full stdout parses as JSON. Keys: ${Object.keys(parsed).join(', ')}`);
        log(`  [json] Content: ${JSON.stringify(parsed, null, 2).substring(0, 500)}`);
      } catch {
        // Try line-by-line JSON parse
        const lines = fullStdout.split('\n').filter(l => l.trim());
        let jsonLines = 0;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            jsonLines++;
            log(`  [json-line] type=${obj.type || 'unknown'} keys=${Object.keys(obj).join(',')}`);
          } catch {
            // not json
          }
        }
        if (jsonLines === 0 && fullStdout.length > 0) {
          log(`  [json] Not JSON parseable (neither full nor line-by-line)`);
        }
      }

      resolve({ label, code, chunks, killed, elapsed });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      log(`  [error] ${err.message}`);
      resolve({ label, code: -1, chunks, killed, elapsed: Date.now() - startTime });
    });
  });
}

async function main() {
  log('SPIKE: Claude CLI Behavior Investigation');
  log(`Date: ${new Date().toISOString()}`);
  log(`Platform: ${process.platform}`);
  log(`Node: ${process.version}`);

  // Test (a): Basic piped stdio with -p flag
  await runClaude('(a) Piped stdio with -p', [
    '-p', 'what is 2+2? reply with just the number'
  ]);

  // Test (b1): stream-json output format
  await runClaude('(b1) stream-json format', [
    '-p', '--output-format', 'stream-json',
    'what is 2+2? reply with just the number'
  ]);

  // Test (b2): json output format
  await runClaude('(b2) json format', [
    '-p', '--output-format', 'json',
    'what is 2+2? reply with just the number'
  ]);

  // Test (c): dangerously-skip-permissions
  await runClaude('(c) skip-permissions + stream-json', [
    '-p', '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    'what is 2+2? reply with just the number'
  ]);

  // Test (c2): permission-mode bypassPermissions
  await runClaude('(c2) permission-mode bypass + stream-json', [
    '-p', '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json',
    'what is 2+2? reply with just the number'
  ]);

  log('\n' + '='.repeat(60));
  log('ALL TESTS COMPLETE');
  log('='.repeat(60));

  saveResults();
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  saveResults();
});

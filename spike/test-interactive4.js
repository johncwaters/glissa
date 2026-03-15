const { spawn } = require('child_process');

const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
delete cleanEnv.CLAUDE_CODE_SSE_PORT;
delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

console.log('Test: interactive claude with stdin prompt...\n');

const proc = spawn('claude', [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: cleanEnv,
  cwd: 'C:/Users/john.c.waters/source/repos/glissa',
  shell: true
});

let chunkCount = 0;

proc.stdout.on('data', (data) => {
  chunkCount++;
  const text = data.toString();
  const hasAnsi = /\x1b\[/.test(text);
  console.log(`[stdout #${chunkCount}] size=${data.length} hasAnsi=${hasAnsi}`);
  console.log(`  content: ${JSON.stringify(text.substring(0, 500))}`);
});

proc.stderr.on('data', (data) => {
  console.log(`[stderr] ${JSON.stringify(data.toString().substring(0, 500))}`);
});

proc.on('exit', (code, signal) => {
  console.log(`\nExited: code=${code} signal=${signal} chunks=${chunkCount}`);
});

// Send a prompt after 2 seconds
setTimeout(() => {
  console.log('\n--- Sending prompt via stdin ---');
  proc.stdin.write('what is 2+2? reply with just the number\n');
}, 2000);

// Kill after 30 seconds
setTimeout(() => {
  console.log('\n--- 30s timeout: killing ---');
  proc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
}, 30000);

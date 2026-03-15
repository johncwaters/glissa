const { spawn } = require('child_process');

const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
delete cleanEnv.CLAUDE_CODE_SSE_PORT;
delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

const claudePath = process.env.APPDATA + '\npm\claude.cmd';
console.log('Spawning claude interactively (NO -p flag) via:', claudePath);
console.log('Capturing output for 20 seconds...\n');

const proc = spawn(claudePath, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: cleanEnv,
  cwd: 'C:/Users/john.c.waters/source/repos/glissa'
});

let chunkCount = 0;

proc.stdout.on('data', (data) => {
  chunkCount++;
  const text = data.toString();
  const hasAnsi = /\x1b\[/.test(text);
  const hasQuestion = /\?|y\/n|yes\/no|proceed|allow/i.test(text);
  console.log(`[stdout #${chunkCount}] size=${data.length} hasAnsi=${hasAnsi} hasQuestion=${hasQuestion}`);
  console.log(`  content: ${JSON.stringify(text.substring(0, 500))}`);
  console.log();
});

proc.stderr.on('data', (data) => {
  console.log(`[stderr] size=${data.length}`);
  console.log(`  content: ${JSON.stringify(data.toString().substring(0, 500))}`);
  console.log();
});

proc.on('error', (err) => {
  console.log('Spawn error:', err.message);
});

proc.on('exit', (code, signal) => {
  console.log(`\nProcess exited: code=${code} signal=${signal}`);
  console.log(`Total stdout chunks: ${chunkCount}`);
});

setTimeout(() => {
  console.log('\n--- 20s timeout: killing ---');
  proc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 2000);
}, 20000);

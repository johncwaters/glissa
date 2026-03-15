const { spawn } = require('child_process');

const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
delete cleanEnv.CLAUDE_CODE_SSE_PORT;
delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

console.log('Spawning claude interactively (NO -p flag, shell: true)...');
console.log('Capturing output for 25 seconds...\n');

const proc = spawn('claude', [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: cleanEnv,
  cwd: 'C:/Users/john.c.waters/source/repos/glissa',
  shell: true
});

let chunkCount = 0;
let allStdout = '';

proc.stdout.on('data', (data) => {
  chunkCount++;
  const text = data.toString();
  allStdout += text;
  const hasAnsi = /\x1b\[/.test(text);
  const hasQuestion = /\?|y\/n|yes\/no|proceed|allow/i.test(text);
  console.log(`[stdout #${chunkCount}] size=${data.length} hasAnsi=${hasAnsi} hasQuestion=${hasQuestion}`);
  console.log(`  raw bytes: ${[...data.slice(0, 80)].map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
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
  console.log(`Total stdout bytes: ${allStdout.length}`);
  console.log(`Has ANSI anywhere: ${/\x1b\[/.test(allStdout)}`);
});

setTimeout(() => {
  console.log('\n--- 25s timeout: killing ---');
  proc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
}, 25000);

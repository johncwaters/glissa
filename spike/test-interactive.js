const { spawn } = require('child_process');

// Clean env to avoid nesting detection
const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE;
delete cleanEnv.CLAUDE_CODE_SSE_PORT;
delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

console.log('Spawning claude in interactive mode (NO -p flag)...');
console.log('Will capture output for 20 seconds then kill.\n');

const proc = spawn('claude', [], {
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
  console.log(`[stdout chunk #${chunkCount}] size=${data.length} hasAnsi=${hasAnsi} hasQuestion=${hasQuestion}`);
  console.log(`  content: ${JSON.stringify(text.substring(0, 300))}`);
  console.log();
});

proc.stderr.on('data', (data) => {
  const text = data.toString();
  console.log(`[stderr] size=${data.length}`);
  console.log(`  content: ${JSON.stringify(text.substring(0, 300))}`);
  console.log();
});

proc.on('exit', (code, signal) => {
  console.log(`\nProcess exited: code=${code} signal=${signal}`);
  console.log(`Total stdout chunks: ${chunkCount}`);
});

// Kill after 20 seconds
setTimeout(() => {
  console.log('\n--- Timeout: killing process ---');
  proc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 2000);
}, 20000);

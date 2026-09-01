import fs from 'node:fs';
import path from 'node:path';

const VENDOR_HOME_VARS = Object.freeze(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME']);

function isolateTranscriptHomes(dir: string, env: NodeJS.ProcessEnv = process.env): () => void {
  const previous = new Map<string, string | undefined>(VENDOR_HOME_VARS.map((name) => [name, env[name]]));
  const home = path.join(dir, 'vendor-homes');
  fs.mkdirSync(home, { recursive: true });
  for (const name of VENDOR_HOME_VARS) env[name] = path.join(home, name.toLowerCase());
  return function restore() {
    for (const [name, value] of previous) {
      if (value == null) delete env[name];
      if (value != null) env[name] = value;
    }
  };
}

export { VENDOR_HOME_VARS, isolateTranscriptHomes };

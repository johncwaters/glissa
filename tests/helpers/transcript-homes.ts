import fs from 'node:fs';
import path from 'node:path';

/*
 * SAFETY helper for every test that boots a backend with `memory.enabled`. That switch implies the
 * agent-log source (docs/plan-visions-3.md, M14), which tails the local agent CLIs' transcripts and
 * backfills from them, so a boot left pointing at the real vendor homes would read the operator's own
 * conversations. Point all three somewhere empty and throwaway first.
 */

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

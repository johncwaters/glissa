'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Build a stage's initial prompt: the agent role markdown plus a RUN CONTEXT block carrying the
// absolute paths the agent must read and write. The prompt is delivered to `claude -p` via a FILE
// (writePromptFile), never as a positional CLI arg — this avoids the cmd.exe-shim quoting hazard
// for multi-KB prompts (see .omc/plans/marketing-team-pipeline.md section 3.10).

// runContext: { runDir, packDir?, packFiles?: [{name, path}], reads?: [{name, path}], produces?: {name, path} }
// packDir/packFiles point at the project-owned pack (voice rules, brand, calendar, channels) under
// .glissa/teams/<id>/pack/. The agent reads its specifics from there; glissa owns only the role text.
function buildStagePrompt(agentMarkdown, runContext) {
  const {
    runDir, packDir, packFiles = [], reads = [], produces,
  } = runContext || {};
  const lines = [];
  lines.push(String(agentMarkdown || '').trimEnd());
  lines.push('');
  lines.push('---');
  lines.push('## RUN CONTEXT');
  lines.push(`- Run folder: ${runDir}`);
  if (packDir) lines.push(`- Pack folder (this project's voice and brand rules): ${packDir}`);
  if (packFiles.length > 0) {
    lines.push('- Project pack files:');
    for (const f of packFiles) {
      lines.push(`  - ${f.name}: ${f.path}`);
    }
  }
  if (reads.length > 0) {
    lines.push('- Read these inputs first:');
    for (const r of reads) {
      lines.push(`  - ${r.name}: ${r.path}`);
    }
  }
  if (produces) {
    lines.push(`- Write your single output file to: ${produces.path}`);
  }
  lines.push('');
  lines.push(
    'Read every input file listed above, then write your output to the exact path given. '
      + 'Do not write to any other location.',
  );
  return lines.join('\n');
}

// Write the prompt to a uniquely-named file under `dir` and return its absolute path.
function writePromptFile(dir, content) {
  fs.mkdirSync(dir, { recursive: true });
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, `stage-prompt-${unique}.md`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

module.exports = { buildStagePrompt, writePromptFile };

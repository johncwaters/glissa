'use strict';

// Build a stage's initial prompt: the agent role markdown plus a RUN CONTEXT block carrying the
// absolute paths the agent must read and write. The orchestrator passes the built string directly as
// the stage session's initial prompt, never as a positional CLI arg (which would hit the cmd.exe-shim
// quoting hazard for multi-KB prompts; see .omc/plans/marketing-team-pipeline.md section 3.10).

// runContext: { runDir, packDir?, packFiles?: [{name, path}], reads?: [{name, path}], produces?: {name, path} }
// packDir/packFiles point at the project-owned pack (voice rules, brand, calendar, channels) under
// .glissa/teams/<id>/pack/. The agent reads its specifics from there; glissa owns only the role text.
function buildStagePrompt(agentMarkdown, runContext) {
  const {
    runDir, packDir, packFiles = [], reads = [], produces, chat = null, allowQuestions = false,
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
  // The operator conversation (chat.md) is elevated above ordinary inputs: it carries the human's
  // steering notes and answers to any questions raised earlier in the run.
  if (chat) {
    lines.push(`- Operator conversation (READ AND HONOR, the human operator's steering and answered questions): ${chat.path}`);
  }
  if (produces) {
    lines.push(`- Write your single output file to: ${produces.path}`);
  }
  lines.push('');
  lines.push(
    'Read every input file listed above, then write your output to the exact path given. '
      + 'Do not write to any other location.',
  );
  if (chat) {
    lines.push('');
    lines.push(
      'Read the operator conversation file and honor any guidance and answered questions there. '
        + 'If it conflicts with earlier instructions, the operator wins.',
    );
  }
  // QUESTION protocol: injected only when the run is interactive (manual run on a team with
  // chat.allowQuestions). An agent that cannot resolve an ambiguity writes the marker as its ENTIRE
  // output; the orchestrator pauses the run, surfaces it to the operator, and re-runs this stage once
  // the answer lands in the conversation file. Omitted entirely on scheduled/unattended runs.
  if (allowQuestions) {
    lines.push('');
    lines.push(
      'If you hit an ambiguity you genuinely cannot resolve from the pack, the inputs, and the '
        + 'operator conversation, write exactly "QUESTION: <one specific question>" as the ENTIRE '
        + 'contents of your output file and stop. Do not guess. Use this sparingly, only when guessing '
        + 'would risk the run. The operator answers and you run again with their answer in the '
        + 'conversation file.',
    );
  }
  return lines.join('\n');
}

module.exports = { buildStagePrompt };

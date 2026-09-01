// Home database writes from a test can modify the operator's live memory store.

import path from 'node:path';

const HOME_DB_REFUSED_CODE = 'GLISSA_HOME_DB_REFUSED';
const HOME_DB_REFUSED_NAME = 'GlissaHomeDbRefusedError';

function isUnder(child: unknown, parent: unknown): boolean {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return false;
  const from = path.resolve(parent);
  const to = path.resolve(child);
  const relative = path.relative(from, to);
  if (relative === '') return true;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return true;
}

function underTestRunner(env: { NODE_TEST_CONTEXT?: string } | null | undefined): boolean {
  const marker = env ? env.NODE_TEST_CONTEXT : undefined;
  return typeof marker === 'string' && marker !== '';
}

/**
 * Returns the refusal message, or null when the open may proceed.
 */
function decideDbOpenRefusal({
  dbPath,
  homeDir,
  tmpDir,
  isTestRunner,
}: {
  dbPath: string;
  homeDir: string;
  tmpDir: string;
  isTestRunner: boolean;
}): string | null {
  if (!isTestRunner) return null;
  if (!isUnder(dbPath, homeDir)) return null;
  // A Windows runner's %TEMP% sits under the home directory, so every temp fixture would be refused.
  if (isUnder(dbPath, tmpDir)) return null;
  return `refusing to open a database under the home directory while running under the node test runner: ${dbPath}`;
}

function homeDbRefusedError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = HOME_DB_REFUSED_NAME;
  error.code = HOME_DB_REFUSED_CODE;
  return error;
}

export {
  HOME_DB_REFUSED_CODE,
  HOME_DB_REFUSED_NAME,
  decideDbOpenRefusal,
  homeDbRefusedError,
  isUnder,
  underTestRunner,
};

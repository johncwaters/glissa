import path from 'node:path';

interface PlatformScope {
  pathEnv?: string;
  platform?: NodeJS.Platform;
}

interface GlobalBinScope {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  resolvedPrefix?: string | null;
}

interface PathNoticeScope {
  installedBinDir?: string | null;
  onPathFlag?: boolean;
  platform?: NodeJS.Platform;
}

function isWin(platform: NodeJS.Platform | undefined): boolean {
  return platform === 'win32';
}

function normalizeDir(dir: string | null | undefined, platform: NodeJS.Platform | undefined): string {
  if (!dir) return '';
  let d = String(dir).trim();
  if (d.length >= 2 && d.startsWith('"') && d.endsWith('"')) {
    d = d.slice(1, -1);
  }
  d = d.replace(/[\\/]+$/, '');
  if (d === '') return '';
  return isWin(platform) ? d.toLowerCase() : d;
}

function onPath(dir: string | null | undefined, { pathEnv, platform }: PlatformScope = {}): boolean {
  const target = normalizeDir(dir, platform);
  if (!target) return false;
  const sep = isWin(platform) ? ';' : ':';
  for (const entry of String(pathEnv || '').split(sep)) {
    if (normalizeDir(entry, platform) === target) return true;
  }
  return false;
}

function npmGlobalBinDir({ env = {}, platform, homedir, resolvedPrefix }: GlobalBinScope = {}): string | null {
  const prefix = env.npm_config_prefix || resolvedPrefix || null;
  if (isWin(platform)) {
    if (prefix) return prefix;
    if (homedir) return path.join(homedir, 'AppData', 'Roaming', 'npm');
    return null;
  }
  if (prefix) return path.join(prefix, 'bin');
  return null;
}

function pnpmGlobalBinDir({ env = {}, platform, homedir }: GlobalBinScope = {}): string | null {
  if (env.PNPM_HOME) return env.PNPM_HOME;
  if (!homedir) return null;
  if (isWin(platform)) return path.join(homedir, 'AppData', 'Local', 'pnpm');
  return path.join(homedir, '.local', 'share', 'pnpm');
}

function formatPathNotice({ installedBinDir, onPathFlag, platform }: PathNoticeScope = {}): string {
  const dir = installedBinDir || '(unknown)';
  if (onPathFlag) {
    return [
      'glissa installed. Its command directory is on your PATH:',
      `  ${dir}`,
      'Run "glissa" to start, or "glissa doctor" to check your setup.',
    ].join('\n');
  }
  const lines = [
    'glissa was installed, but its command directory is NOT on your PATH:',
    `  ${dir}`,
    'That is why typing "glissa" is not recognized yet. To fix it:',
  ];
  if (isWin(platform)) {
    lines.push('  In PowerShell (adds it to your user PATH, permanent):');
    lines.push(`    [Environment]::SetEnvironmentVariable("PATH", [Environment]::GetEnvironmentVariable("PATH","User") + ";${dir}", "User")`);
    lines.push('  Then open a NEW terminal and run "glissa".');
    lines.push('  (Reinstalling Node.js from the official installer also adds this directory for you.)');
  }
  if (!isWin(platform)) {
    lines.push(`  Add to your shell profile:  export PATH="$PATH:${dir}"`);
    lines.push('  Then open a new terminal and run "glissa".');
  }
  lines.push('See the README "Troubleshooting" section for more, including pnpm setups.');
  return lines.join('\n');
}

export { onPath, npmGlobalBinDir, pnpmGlobalBinDir, formatPathNotice };

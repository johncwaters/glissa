import fs from 'node:fs';
import path from 'node:path';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface PruneAgedFilesOptions {
  directory: string;
  suffixes: string[];
  retainDays: number;
  now?: number;
  isRetainedId?: (id: string) => boolean;
  entryMode?: 'file' | 'directory';
  fsPromises?: Pick<typeof fs.promises, 'readdir' | 'stat' | 'unlink' | 'rm'>;
}

function idForEntry(entry: string, suffixes: string[]): string | null {
  for (const suffix of suffixes) {
    if (suffix.length === 0) return entry;
    if (entry.endsWith(suffix)) return entry.slice(0, -suffix.length);
  }
  return null;
}

async function pruneAgedFiles({
  directory,
  suffixes,
  retainDays,
  now = Date.now(),
  isRetainedId = () => false,
  entryMode = 'file',
  fsPromises = fs.promises,
}: PruneAgedFilesOptions): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsPromises.readdir(directory);
  } catch {
    return [];
  }
  const cutoff = now - (retainDays * MS_PER_DAY);
  const removedIds: string[] = [];
  for (const entry of entries) {
    const id = idForEntry(entry, suffixes);
    if (!id || isRetainedId(id)) continue;
    const filePath = path.join(directory, entry);
    try {
      const stat = await fsPromises.stat(filePath);
      if (stat.mtimeMs >= cutoff) continue;
      if (entryMode === 'directory') await fsPromises.rm(filePath, { recursive: true, force: true });
      if (entryMode === 'file') await fsPromises.unlink(filePath);
      removedIds.push(id);
    } catch {
    }
  }
  return removedIds;
}

export { idForEntry, pruneAgedFiles };
export type { PruneAgedFilesOptions };

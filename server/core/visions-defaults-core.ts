const IMPLIED_INGEST = Object.freeze({
  enabled: true,
  sources: Object.freeze({
    fs: Object.freeze({ enabled: true }),
    git: Object.freeze({ enabled: true }),
    editor: Object.freeze({ enabled: true }),
  }),
});

export interface ImpliedChange {
  path: string[];
  value: unknown;
  why: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function impliedIngestChanges(config: Record<string, unknown>): ImpliedChange[] {
  if (!isPlainObject(config.ingest)) {
    return [{ path: ['ingest'], value: JSON.parse(JSON.stringify(IMPLIED_INGEST)), why: 'visions needs machine context' }];
  }
  const changes: ImpliedChange[] = [];
  if (config.ingest.enabled !== true && config.ingest.enabled !== false) {
    changes.push({ path: ['ingest', 'enabled'], value: true, why: 'visions needs machine context' });
  }
  if (config.ingest.enabled === false) return changes;
  const sources: Record<string, unknown> = isPlainObject(config.ingest.sources) ? config.ingest.sources : {};
  for (const [name, value] of Object.entries(IMPLIED_INGEST.sources)) {
    if (isPlainObject(sources[name])) continue;
    changes.push({ path: ['ingest', 'sources', name], value: JSON.parse(JSON.stringify(value)), why: `visions implies the ${name} source` });
  }
  return changes;
}

function decideImpliedDefaults(config: Record<string, unknown> | null | undefined): { changes: ImpliedChange[] } {
  if (!config) return { changes: [] };
  const visions = config.visions;
  if (!isPlainObject(visions) || visions.enabled !== true) return { changes: [] };
  const changes = impliedIngestChanges(config);
  if (!isPlainObject(visions.dispatch)) changes.push({ path: ['visions', 'dispatch'], value: { enabled: true }, why: 'visions implies its model dispatch' });
  return { changes };
}

function applyChanges<T extends Record<string, unknown>>(config: T, changes: ImpliedChange[]): T {
  for (const change of changes) {
    let cursor: Record<string, unknown> = config;
    for (const key of change.path.slice(0, -1)) {
      const existing = cursor[key];
      if (isPlainObject(existing)) {
        cursor = existing;
        continue;
      }
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    }
    cursor[change.path[change.path.length - 1]] = change.value;
  }
  return config;
}

export { IMPLIED_INGEST, applyChanges, decideImpliedDefaults };

import type { createBackend } from '../../server/backend.ts';
import type { createIngestLane } from '../../server/ingest-wiring.ts';
import type { createMemoryDistiller } from '../../server/memory-distill.ts';
import type { createMemoryIngest } from '../../server/memory-ingest-wiring.ts';
import type { createMemoryStore } from '../../server/memory-store.ts';
import type { createUsageWiring } from '../../server/usage-wiring.ts';
import type { createVisionsWiring } from '../../server/visions-wiring.ts';

type Backend = ReturnType<typeof createBackend>;
type IngestLane = ReturnType<typeof createIngestLane>;
type MemoryDistiller = ReturnType<typeof createMemoryDistiller>;
type MemoryIngest = ReturnType<typeof createMemoryIngest>;
type MemoryStore = ReturnType<typeof createMemoryStore>;
type UsageLane = ReturnType<typeof createUsageWiring>;
type VisionsLane = ReturnType<typeof createVisionsWiring>;

function ingestLane(backend: Backend): IngestLane | null {
  return backend.getLane('ingest');
}

function memoryDistillLane(backend: Backend): MemoryDistiller | null {
  return backend.getLane('memory-distill');
}

function memoryIngestLane(backend: Backend): MemoryIngest | null {
  return backend.getLane('memory-ingest');
}

function memoryStoreLane(backend: Backend): MemoryStore | null {
  return backend.getLane('memory-store');
}

function usageLane(backend: Backend): UsageLane {
  return backend.getLane('usage');
}

function visionsLane(backend: Backend): VisionsLane | null {
  return backend.getLane('visions');
}

export {
  ingestLane, memoryDistillLane, memoryIngestLane, memoryStoreLane, usageLane, visionsLane,
};
export type {
  Backend, IngestLane, MemoryDistiller, MemoryIngest, MemoryStore, UsageLane, VisionsLane,
};

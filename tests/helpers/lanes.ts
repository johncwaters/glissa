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
  return backend.getLane('ingest') as IngestLane | null;
}

function memoryDistillLane(backend: Backend): MemoryDistiller | null {
  return backend.getLane('memory-distill') as MemoryDistiller | null;
}

function memoryIngestLane(backend: Backend): MemoryIngest | null {
  return backend.getLane('memory-ingest') as MemoryIngest | null;
}

function memoryStoreLane(backend: Backend): MemoryStore | null {
  return backend.getLane('memory-store') as MemoryStore | null;
}

function usageLane(backend: Backend): UsageLane {
  return backend.getLane('usage') as UsageLane;
}

function visionsLane(backend: Backend): VisionsLane | null {
  return backend.getLane('visions') as VisionsLane | null;
}

export {
  ingestLane, memoryDistillLane, memoryIngestLane, memoryStoreLane, usageLane, visionsLane,
};
export type {
  Backend, IngestLane, MemoryDistiller, MemoryIngest, MemoryStore, UsageLane, VisionsLane,
};

import { Session } from '../../session/sessions.ts';
import type { SessionOptions } from '../../session/sessions.ts';
import { fakePty } from './fake-pty.ts';

interface RecordingSessionFactory {
  makeSession: (options: SessionOptions) => Session;
  constructed: SessionOptions[];
  created: Session[];
}

function recordingSessionFactory(): RecordingSessionFactory {
  const constructed: SessionOptions[] = [];
  const created: Session[] = [];
  const makeSession = (options: SessionOptions): Session => {
    constructed.push(options);
    const session = new Session({ ...options, ptySpawn: () => fakePty() });
    created.push(session);
    return session;
  };
  return { makeSession, constructed, created };
}

function plainSession(id: string, name: string = id, projectPath = '/repo'): Session {
  return new Session({ id, name, path: projectPath, ptySpawn: () => fakePty() });
}

export { plainSession, recordingSessionFactory };
export type { RecordingSessionFactory };

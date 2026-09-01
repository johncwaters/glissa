import { Session } from '../../session/sessions.ts';
import type { SessionOptions } from '../../session/sessions.ts';
import { fakePty } from './fake-pty.ts';

// A recording stand-in for the Session constructor, handed to a wiring through its makeSession seam,
// so lane tests can pin the exact Session options a wiring builds without spawning anything. The
// object handed back is a REAL Session (the lanes park it in their maps and await its exit), with an
// inert PTY injected so a start that slips through launches no process.

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

// A real, unstarted Session for a suite that only needs one to exist in a map: the control dispatch
// looks sessions up by id and calls one method on the hit. A suite pins that call by replacing the
// method on this instance, which keeps the replacement typed against the real signature.
function plainSession(id: string, name: string = id, projectPath = '/repo'): Session {
  return new Session({ id, name, path: projectPath, ptySpawn: () => fakePty() });
}

export { plainSession, recordingSessionFactory };
export type { RecordingSessionFactory };

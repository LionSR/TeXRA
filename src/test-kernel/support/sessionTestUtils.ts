import {
  SessionHandle,
  type SessionHandleInit,
} from '@agent/runtime/SessionHandle';
import { StreamLogStore } from '@transcript';

type TestSessionInit = Omit<SessionHandleInit, 'transcripts'> & {
  readonly transcripts?: StreamLogStore;
};

/** Construct an isolated session with an explicitly ephemeral transcript. */
export function createTestSession(init: TestSessionInit = {}): SessionHandle {
  return new SessionHandle({
    ...init,
    transcripts:
      init.transcripts ?? StreamLogStore.ephemeral('isolated test session'),
  });
}

import {
  agentResponseTextConnector,
  initializeDefaultSession,
  tryDefaultSession,
  type SessionHandle,
} from '@agent/runtime';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { StreamLogStore } from '@transcript';

const responseTextProcessing = createTexraResponseTextProcessing(
  agentResponseTextConnector,
);

type OpenPersistentStore = () => Promise<StreamLogStore>;

function persistentSession(session: SessionHandle): SessionHandle {
  if (session.transcripts.mode.kind !== 'persistent') {
    const detail =
      session.transcripts.mode.kind === 'ephemeral'
        ? `ephemeral (${session.transcripts.mode.reason})`
        : 'read-only';
    throw new Error(
      `Persistent transcripts are required, but the default session is ${detail}.`,
    );
  }
  return session;
}

/** Open the CLI's persistent session. Its owner runs indexed cleanup. */
export async function initializeCliTranscriptSession(
  openPersistentStore: OpenPersistentStore = () => StreamLogStore.open(),
): Promise<SessionHandle> {
  const existing = tryDefaultSession();
  if (existing) return persistentSession(existing);

  const session = persistentSession(
    initializeDefaultSession({
      transcripts: await openPersistentStore(),
      responseTextProcessing,
    }),
  );
  return session;
}

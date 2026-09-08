import {
  agentResponseTextConnector,
  initializeDefaultSession,
  tryDefaultSession,
  type SessionHandle,
} from '@agent/runtime';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';

const responseTextProcessing = createTexraResponseTextProcessing(
  agentResponseTextConnector,
);

function persistentSession(session: SessionHandle): SessionHandle {
  if (session.transcripts.mode.kind !== 'persistent') {
    const detail = `ephemeral (${session.transcripts.mode.reason})`;
    throw new Error(
      `Persistent transcripts are required, but the default session is ${detail}.`,
    );
  }
  return session;
}

/** Open the CLI's persistent session. Its owner runs indexed cleanup. */
export async function initializeCliTranscriptSession(): Promise<SessionHandle> {
  const existing = tryDefaultSession();
  if (existing) return persistentSession(existing);

  const session = persistentSession(
    initializeDefaultSession({
      responseTextProcessing,
    }),
  );
  return session;
}

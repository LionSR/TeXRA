import {
  createAgentResponseTextConnector,
  initializeDefaultSession,
  tryDefaultSession,
  type SessionHandle,
} from '@agent/runtime';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { sessionStoreClearedMessage } from '@shared/copy/sessionStore';
import { writeTextStderr } from './logSinks';

function persistentSession(session: SessionHandle): SessionHandle {
  if (session.transcripts.mode.kind !== 'persistent') {
    const detail = `ephemeral (${session.transcripts.mode.reason})`;
    throw new Error(
      `Persistent transcripts are required, but the default session is ${detail}.`,
    );
  }
  return session;
}

/**
 * Open the CLI's persistent session. Its owner runs indexed cleanup.
 *
 * `stores` are the process secret store and global state the entry point
 * already holds from `initCliPlatform`: the latex text connector asks a helper
 * model how to join two strings, and that model is resolved against them. They
 * are read only by the call that actually opens the session; a later call
 * returns the session already open.
 */
export async function initializeCliTranscriptSession(
  stores: ModelOptionStores,
): Promise<SessionHandle> {
  const existing = tryDefaultSession();
  if (existing) return persistentSession(existing);

  const session = persistentSession(
    initializeDefaultSession({
      responseTextProcessing: createTexraResponseTextProcessing(
        createAgentResponseTextConnector(stores),
      ),
    }),
  );
  // The one fact about the store the user must hear: said on stderr before
  // any UI mounts, on the open that cleared it and never again.
  if (session.storeCleared) {
    writeTextStderr(sessionStoreClearedMessage(session.storeCleared));
  }
  return session;
}

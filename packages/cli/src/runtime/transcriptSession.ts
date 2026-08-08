import {
  initializeDefaultSession,
  tryDefaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { createSessionStores } from '@controllers/session/sessionStores';
import { texraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { ephemeralTranscriptWarning, StreamLogStore } from '@transcript';

export type InteractiveTranscriptPolicy =
  | { readonly onPersistentOpenFailure: 'fail' }
  | {
      readonly onPersistentOpenFailure: 'use-ephemeral';
      readonly showPersistentWarning: (message: string) => void;
    };

export interface CliTranscriptSession {
  readonly session: SessionHandle;
  readonly canResume: boolean;
  readonly warning?: string;
}

type OpenPersistentStore = () => Promise<StreamLogStore>;

async function persistentSession(
  session: SessionHandle,
): Promise<CliTranscriptSession> {
  await session.waitUntilReady();
  if (session.transcripts.mode.kind !== 'persistent') {
    const detail =
      session.transcripts.mode.kind === 'ephemeral'
        ? `ephemeral (${session.transcripts.mode.reason})`
        : 'read-only';
    throw new Error(
      `Persistent transcripts are required, but the default session is ${detail}.`,
    );
  }
  return { session, canResume: true };
}

async function initializePersistentSession(
  transcripts: StreamLogStore,
): Promise<CliTranscriptSession> {
  const result = await persistentSession(
    initializeDefaultSession({
      transcripts,
      responseTextProcessing: texraResponseTextProcessing,
    }),
  );
  await createSessionStores(result.session).sweepLeftoverStreams();
  return result;
}

/** Prepare the process session for a noninteractive run before it can start. */
export async function initializeHeadlessTranscriptSession(
  openPersistentStore: OpenPersistentStore = () => StreamLogStore.open(),
): Promise<CliTranscriptSession> {
  const existing = tryDefaultSession();
  if (existing) return persistentSession(existing);

  const transcripts = await openPersistentStore();
  return initializePersistentSession(transcripts);
}

/**
 * Prepare the interactive TUI session under an explicit persistence policy.
 * Only the `use-ephemeral` arm permits an in-memory session after open failure.
 */
export async function initializeInteractiveTranscriptSession(
  policy: InteractiveTranscriptPolicy,
  openPersistentStore: OpenPersistentStore = () => StreamLogStore.open(),
): Promise<CliTranscriptSession> {
  const existing = tryDefaultSession();
  if (existing) {
    await existing.waitUntilReady();
    if (
      existing.transcripts.mode.kind !== 'ephemeral' ||
      policy.onPersistentOpenFailure === 'fail'
    ) {
      return persistentSession(existing);
    }
    const warning = ephemeralTranscriptWarning(
      existing.transcripts.mode.reason,
    );
    policy.showPersistentWarning(warning);
    return { session: existing, canResume: false, warning };
  }

  if (policy.onPersistentOpenFailure === 'fail') {
    return initializePersistentSession(await openPersistentStore());
  }

  const transcripts = await StreamLogStore.openOrEphemeral(openPersistentStore);
  if (transcripts.mode.kind !== 'ephemeral') {
    return initializePersistentSession(transcripts);
  }

  const warning = ephemeralTranscriptWarning(transcripts.mode.reason);
  const session = initializeDefaultSession({
    transcripts,
    responseTextProcessing: texraResponseTextProcessing,
  });
  await session.waitUntilReady();
  policy.showPersistentWarning(warning);
  return { session, canResume: false, warning };
}

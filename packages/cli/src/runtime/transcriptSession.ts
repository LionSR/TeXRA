import { StreamLogStore } from '@transcript';
import {
  initializeDefaultSession,
  tryDefaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { toErrorMessage } from '@utils/errors/errorMessage';

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

function persistentSession(session: SessionHandle): CliTranscriptSession {
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

/** Prepare the process session for a noninteractive run before it can start. */
export async function initializeHeadlessTranscriptSession(
  openPersistentStore: OpenPersistentStore = () => StreamLogStore.open(),
): Promise<CliTranscriptSession> {
  const existing = tryDefaultSession();
  if (existing) return persistentSession(existing);

  const transcripts = await openPersistentStore();
  return persistentSession(initializeDefaultSession({ transcripts }));
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
    if (existing.transcripts.mode.kind === 'persistent') {
      return { session: existing, canResume: true };
    }
    if (existing.transcripts.mode.kind === 'read-only') {
      return persistentSession(existing);
    }
    if (policy.onPersistentOpenFailure === 'fail') {
      return persistentSession(existing);
    }
    const warning = formatEphemeralWarning(existing.transcripts.mode.reason);
    policy.showPersistentWarning(warning);
    return { session: existing, canResume: false, warning };
  }

  let transcripts: StreamLogStore;
  try {
    transcripts = await openPersistentStore();
  } catch (error) {
    if (policy.onPersistentOpenFailure === 'fail') throw error;

    const reason = `Persistent transcript opening failed: ${toErrorMessage(error)}`;
    const warning = formatEphemeralWarning(reason);
    const session = initializeDefaultSession({
      transcripts: StreamLogStore.ephemeral(reason),
    });
    policy.showPersistentWarning(warning);
    return { session, canResume: false, warning };
  }

  return persistentSession(initializeDefaultSession({ transcripts }));
}

function formatEphemeralWarning(reason: string): string {
  return `Transcript persistence is unavailable for this session. Its conversation cannot be resumed. ${reason}`;
}

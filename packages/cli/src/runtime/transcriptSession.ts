import { SessionStores } from '@agent/storage';
import {
  initializeDefaultSession,
  tryDefaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { texraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { GoalStore } from '@tools/goal';
import { StreamLogStore } from '@transcript';
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
  const stores = new SessionStores({
    streamLogs: result.session.transcripts,
    snapshots: result.session.snapshots,
    goalEntries: {
      forget: (stream) => GoalStore.forget(stream, result.session),
      forgetMany: (streams) => GoalStore.forgetMany(streams, result.session),
    },
  });
  await stores.sweepOrphanedStreams(new Set(result.session.transcripts.keys()));
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
      responseTextProcessing: texraResponseTextProcessing,
    });
    await session.waitUntilReady();
    policy.showPersistentWarning(warning);
    return { session, canResume: false, warning };
  }

  return initializePersistentSession(transcripts);
}

function formatEphemeralWarning(reason: string): string {
  return `Transcript persistence is unavailable for this session. Its conversation cannot be resumed. ${reason}`;
}

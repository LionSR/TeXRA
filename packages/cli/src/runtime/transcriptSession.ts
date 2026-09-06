import {
  agentResponseTextConnector,
  initializeDefaultSession,
  tryDefaultSession,
  type SessionHandle,
} from '@agent/runtime';
import { scheduleLeftoverStreamSweep } from '@controllers/session/scheduleLeftoverStreamSweep';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { ephemeralTranscriptWarning, StreamLogStore } from '@transcript';

const responseTextProcessing = createTexraResponseTextProcessing(
  agentResponseTextConnector,
);

type InteractiveTranscriptPolicy =
  | { readonly ephemeral: 'reject' }
  | {
      readonly ephemeral: 'use-existing';
      readonly showPersistentWarning: (message: string) => void;
    };

interface CliTranscriptSession {
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

function initializePersistentSession(
  transcripts: StreamLogStore,
  sweep: { readonly delayMs?: number } = {},
): CliTranscriptSession {
  const result = persistentSession(
    initializeDefaultSession({
      transcripts,
      responseTextProcessing,
    }),
  );
  // Off the ready path: the sweep reads the whole storage root, and no prompt
  // waits for it. The TUI takes the default delay, which keeps the read off
  // its first paint. A headless `texra run` has no paint to protect and can
  // finish inside that delay — the unref'd timer would never fire, leaving
  // its shells for a launch that may not come — so it schedules with none.
  // Overlapping the run is safe: the sweep excludes the streams this process
  // is running, and it is idempotent if the process exits first.
  scheduleLeftoverStreamSweep(result.session, sweep);
  return result;
}

function ephemeralSession(
  session: SessionHandle,
  reason: string,
  showPersistentWarning: (message: string) => void,
): CliTranscriptSession {
  const warning = ephemeralTranscriptWarning(reason);
  showPersistentWarning(warning);
  return { session, canResume: false, warning };
}

/** Open persistent storage, or use an explicitly supplied session under the caller's policy. */
export async function initializeCliTranscriptSession(
  policy: InteractiveTranscriptPolicy = { ephemeral: 'reject' },
  openPersistentStore: OpenPersistentStore = () => StreamLogStore.open(),
): Promise<CliTranscriptSession> {
  const existing = tryDefaultSession();
  if (existing) {
    if (
      existing.transcripts.mode.kind !== 'ephemeral' ||
      policy.ephemeral === 'reject'
    ) {
      return persistentSession(existing);
    }
    return ephemeralSession(
      existing,
      existing.transcripts.mode.reason,
      policy.showPersistentWarning,
    );
  }

  return initializePersistentSession(
    await openPersistentStore(),
    policy.ephemeral === 'reject' ? { delayMs: 0 } : {},
  );
}

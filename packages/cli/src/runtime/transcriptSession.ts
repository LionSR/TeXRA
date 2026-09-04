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
  | { readonly onPersistentOpenFailure: 'fail' }
  | {
      readonly onPersistentOpenFailure: 'use-ephemeral';
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

/**
 * Prepare the process session under an explicit persistence policy. The
 * default `fail` policy is what every noninteractive run needs; only the
 * `use-ephemeral` arm permits an in-memory session after open failure.
 */
export async function initializeCliTranscriptSession(
  policy: InteractiveTranscriptPolicy = { onPersistentOpenFailure: 'fail' },
  openPersistentStore: OpenPersistentStore = () => StreamLogStore.open(),
): Promise<CliTranscriptSession> {
  const existing = tryDefaultSession();
  if (existing) {
    if (
      existing.transcripts.mode.kind !== 'ephemeral' ||
      policy.onPersistentOpenFailure === 'fail'
    ) {
      return persistentSession(existing);
    }
    return ephemeralSession(
      existing,
      existing.transcripts.mode.reason,
      policy.showPersistentWarning,
    );
  }

  if (policy.onPersistentOpenFailure === 'fail') {
    // The headless shape: no interactive paint to defer the sweep behind.
    return initializePersistentSession(await openPersistentStore(), {
      delayMs: 0,
    });
  }

  const transcripts = await StreamLogStore.openOrEphemeral(openPersistentStore);
  if (transcripts.mode.kind !== 'ephemeral') {
    return initializePersistentSession(transcripts);
  }

  const session = initializeDefaultSession({
    transcripts,
    responseTextProcessing,
  });
  return ephemeralSession(
    session,
    transcripts.mode.reason,
    policy.showPersistentWarning,
  );
}

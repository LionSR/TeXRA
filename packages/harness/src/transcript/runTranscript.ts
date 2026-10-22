/**
 * A run's transcript, built cold from its committed rows on every read by
 * the same reducer the session view runs. The event table is the only truth;
 * nothing here is resident, so there is no cache to keep coherent with it.
 */
import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { DEBUG_MODE_KEY, type RunId } from '@shared/schemas';
import { buildRunTranscript } from '@shared/session/transcriptUpdate';
import { Settings } from '@shared/config/settings';

/** Build the run's transcript from its committed rows; empty when the run
 *  never existed or was removed. Verbosity is read at the call, from the
 *  same config the session view's reader reads. */
export const readRunTranscript = (
  session: Pick<SessionHandle, 'log' | 'roots'>,
  runId: RunId,
) =>
  session.log
    .display(runId)
    .pipe(
      Effect.map((events) =>
        buildRunTranscript(
          events,
          session.roots.config
            ? Settings.getConfig<boolean>(session.roots.config, DEBUG_MODE_KEY)
            : false,
        ),
      ),
    );

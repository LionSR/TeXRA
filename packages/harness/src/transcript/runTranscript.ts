/**
 * A run's transcript, folded cold from its committed rows on every read by
 * the same reducer the session view runs. The event table is the only truth;
 * nothing here is resident, so there is no cache to keep coherent with it.
 */
import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { DEBUG_MODE_KEY, type RunId } from '@shared/schemas';
import { foldRunTranscript } from '@shared/session/transcriptFold';
import { readConfigSettingFrom } from '@utils/config/platformSettings';

/** Fold the run's committed rows into its transcript; empty when the run
 *  never existed or is tombstoned. Verbosity is read at the call, from the
 *  same config authority the session view fold reads. */
export const readRunTranscript = (
  session: Pick<SessionHandle, 'readRunEvents' | 'roots'>,
  runId: RunId,
) =>
  session
    .readRunEvents(runId)
    .pipe(
      Effect.map((events) =>
        foldRunTranscript(
          events,
          session.roots.config
            ? readConfigSettingFrom<boolean>(
                session.roots.config,
                DEBUG_MODE_KEY,
              )
            : false,
        ),
      ),
    );

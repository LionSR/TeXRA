/**
 * A run's transcript entries, folded cold from its committed rows on every
 * read. The event table is the only truth; nothing here is resident, so there
 * is no cache to keep coherent with it.
 */
import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { DEBUG_MODE_KEY, type RunId } from '@shared/schemas';
import { StreamLog } from '@shared/session/traceEntries';
import { applyTraceRow, createTranscriptFold } from '@shared/session/traceFold';
import { readConfigSettingFrom } from '@utils/config/platformSettings';

/** Fold the run's committed rows into transcript entries; empty when the run
 *  never existed or is tombstoned. Verbosity is read at the call, from the
 *  same config authority the session view fold reads. */
export const readRunEntries = (
  session: Pick<SessionHandle, 'readRunEvents' | 'roots'>,
  runId: RunId,
) =>
  session.readRunEvents(runId).pipe(
    Effect.map((events) => {
      if (events.length === 0) return [];
      if (events[0]?.type !== 'run.start' || events[0].seq !== 1) {
        throw new Error('A transcript read must begin with its creation row.');
      }
      const debug = session.roots.config
        ? readConfigSettingFrom<boolean>(session.roots.config, DEBUG_MODE_KEY)
        : false;
      const log = new StreamLog();
      const fold = createTranscriptFold(log);
      for (const event of events) applyTraceRow(fold, event, debug);
      return log.toJSON();
    }),
  );

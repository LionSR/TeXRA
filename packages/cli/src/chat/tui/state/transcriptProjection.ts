import type { StreamTabId } from '@shared/schemas';

import { isChildStreamRemoved } from './childExecutions';
import { syncStreamLog } from './subscribeStreamLog';

export interface ProjectStreamTranscriptOptions {
  /** Treat the stream as final: promote the settled prefix as far as it
   *  reaches, including deferred assistant/tool rows. */
  readonly finalize?: boolean;
}

/**
 * Single projection edge from StreamLogStore into the CLI state slices.
 *
 * Callers that know a stream reached a turn boundary should project through
 * this helper instead of open-coding sync + finalization. That keeps
 * transcript ordering owned by one path. `finalize` applies the same
 * promotion rule the live sync uses, with `streamFinal` forced: the caller
 * knows the turn ended even when the stream's status has not reached its
 * settlement phase yet. A nonterminal workflow call or a running compaction
 * still seals the prefix — bridge cleanup can replace their state after the
 * turn boundary, and `<Static>` is append-only.
 */
export function projectStreamTranscript(
  streamId: StreamTabId,
  options: ProjectStreamTranscriptOptions = {},
): void {
  if (isChildStreamRemoved(streamId)) return;
  syncStreamLog(streamId, options.finalize ? { forceFinal: true } : {});
}

import { Data } from 'effect';

/**
 * A failure to list or load the remote agent catalog. Lives here rather than
 * in `remoteAgentList.ts` so `remoteAgentMeta.ts` can name the type without a
 * static import of the listing module — that module stays lazily imported to
 * keep the auth client out of generic tool closures.
 */
export class RemoteAgentListError extends Data.TaggedError(
  'RemoteAgentListError',
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Timeout for edge-function requests (30 s): one `Effect.timeout` over the
 * request and the body read.
 */
export const FETCH_TIMEOUT_MS = 30_000;

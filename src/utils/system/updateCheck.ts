import { Clock, Effect } from 'effect';

import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';
import { ensureError } from '@utils/errors/errorMessage';

import {
  DAILY_UPDATE_CHECK_INTERVAL_MS,
  isNewerSemverVersion,
} from './semverUpdateCheck';

/** Result of consulting an update source. */
export interface UpdateCheckFetchResult {
  /** Published version, when the source supplied one. */
  version: string | undefined;
  /** Whether the result came from a successful live refresh. */
  refreshed: boolean;
}

interface DailyUpdateCheckOptions {
  currentVersion: string;
  host: 'cli' | 'desktop';
  /** Desktop announces each release only once. */
  notifyOnce?: boolean;
  fetchLatest: Effect.Effect<UpdateCheckFetchResult, Error>;
  notify: (latest: string) => Effect.Effect<void, Error>;
  /** Whether failure to persist the throttle stamp rejects the check. */
  stampFailure?: 'throw' | 'ignore';
}

/** Consult the source, notify, then persist the successful check in that order. */
export const runDailyUpdateCheck = ({
  currentVersion,
  host,
  notifyOnce = false,
  fetchLatest,
  notify,
  stampFailure = 'throw',
}: DailyUpdateCheckOptions) =>
  Effect.gen(function* () {
    const records = yield* UpdateCheckRecords;
    const previous = yield* records.read(host);
    const nowMs = yield* Clock.currentTimeMillis;
    if (
      previous?.lastCheckedAt != null &&
      nowMs - previous.lastCheckedAt < DAILY_UPDATE_CHECK_INTERVAL_MS
    )
      return undefined;

    const { version, refreshed } = yield* fetchLatest;
    if (version === undefined) return undefined;
    const latest = isNewerSemverVersion(version, currentVersion)
      ? version
      : undefined;
    if (
      latest !== undefined &&
      (!notifyOnce || previous?.lastNotifiedVersion !== latest)
    ) {
      if (notifyOnce) {
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* notify(latest);
            yield* records.recordNotified(host, latest);
          }),
        );
      } else {
        yield* notify(latest);
      }
    }
    if (refreshed) {
      const stamp = records.recordChecked(host, nowMs);
      yield* stampFailure === 'ignore' ? Effect.ignore(stamp) : stamp;
    }
    return latest;
  });

interface FetchJsonStringFieldOptions {
  url: string;
  field: string;
  timeoutMs: number;
  headers?: HeadersInit;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch one string field from a JSON response. Update checks are best-effort:
 * non-success responses, malformed payloads, timeouts, and network failures
 * all yield `undefined`.
 */
export const fetchJsonStringField = ({
  url,
  field,
  timeoutMs,
  headers,
  fetchImpl = fetch,
}: FetchJsonStringFieldOptions) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchImpl(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers,
      });
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null) return undefined;
      const value = (body as Record<string, unknown>)[field];
      return typeof value === 'string' && value !== '' ? value : undefined;
    },
    catch: ensureError,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

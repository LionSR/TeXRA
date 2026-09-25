import { Clock, Duration, Effect } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import { withLogChannel } from '@logger/effectLog';
import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';
import { isObject } from '@utils/core';

import {
  DAILY_UPDATE_CHECK_INTERVAL_MS,
  isNewerSemverVersion,
} from './semverUpdateCheck';
import type { Cause } from 'effect';
import type { HttpClientError } from 'effect/unstable/http';

/** Result of consulting an update source. */
export interface UpdateCheckFetchResult {
  /** Published version, when the source supplied one. */
  version: string | undefined;
  /** Whether the result came from a successful live refresh. */
  refreshed: boolean;
}

interface DailyUpdateCheckOptions<R> {
  currentVersion: string;
  host: 'cli' | 'desktop';
  /** Desktop announces each release only once. */
  notifyOnce?: boolean;
  fetchLatest: Effect.Effect<UpdateCheckFetchResult, Error, R>;
  notify: (latest: string) => Effect.Effect<void, Error>;
  /** Whether failure to persist the throttle stamp rejects the check. */
  stampFailure?: 'throw' | 'ignore';
}

/** Consult the source, notify, then persist the successful check in that order. */
export const runDailyUpdateCheck = <R>({
  currentVersion,
  host,
  notifyOnce = false,
  fetchLatest,
  notify,
  stampFailure = 'throw',
}: DailyUpdateCheckOptions<R>) =>
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
  headers?: Readonly<Record<string, string>>;
}

/**
 * Fetch one string field from a JSON response. Update checks are best-effort:
 * non-success responses, malformed payloads, timeouts, and network failures
 * all yield `undefined`, logged at debug (a warning would print on every
 * offline CLI start).
 */
export const fetchJsonStringField = ({
  url,
  field,
  timeoutMs,
  headers,
}: FetchJsonStringFieldOptions): Effect.Effect<
  string | undefined,
  never,
  HttpClient.HttpClient
> =>
  HttpClient.get(url, { headers }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => {
      const value = isObject(body) ? body[field] : undefined;
      return typeof value === 'string' && value !== '' ? value : undefined;
    }),
    Effect.timeout(Duration.millis(timeoutMs)),
    Effect.catch(
      (error: HttpClientError.HttpClientError | Cause.TimeoutError) =>
        Effect.logDebug(`Update check of ${url} failed: ${error.message}`).pipe(
          withLogChannel('updateCheck'),
          Effect.as(undefined),
        ),
    ),
  );

import { Clock, Context, Duration, Effect, Predicate } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { gt as semverGt, valid as semverValid } from 'semver';
import { z } from 'zod';

import { withLogChannel } from '@texra-ai/harness';
import type { ValueFamily } from '@shared/session/valueFamily';

import type { Cause } from 'effect';
import type { HttpClientError } from 'effect/http';

/** The hosts that check for updates, each with its own record. */
export type UpdateCheckHost = 'cli' | 'desktop';

/** Persisted update notification state, isolated by host and configured storage root. */
const UpdateCheckRecordSchema = z.object({
  lastCheckedAt: z.int().nonnegative().nullable(),
  lastNotifiedVersion: z.string().min(1).nullable(),
});
export type UpdateCheckRecord = z.infer<typeof UpdateCheckRecordSchema>;

/**
 * True when `latest` is strictly newer than `current`, using full semver
 * precedence (a plain release outranks any prerelease of the same `x.y.z`, and
 * prereleases compare numerically — so `1.2.0-rc.10` correctly beats
 * `1.2.0-rc.2`). Unparseable inputs yield `false` so a malformed
 * registry/release response can never push a bogus update prompt. The
 * leading `v` some tags carry is tolerated by `semver`.
 *
 * Shared by the CLI (`updateChecker.ts`) and desktop (`desktopUpdateChecker.ts`)
 * update checks, which otherwise poll different sources on the same daily
 * cadence and notify through the same env-var kill switch.
 */
function isNewerSemverVersion(latest: string, current: string): boolean {
  const a = semverValid(latest.trim(), { loose: true });
  const b = semverValid(current.trim(), { loose: true });
  if (!a || !b) return false;
  return semverGt(a, b);
}

/** Poll for updates at most once per day. */
const DAILY_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Env var that disables both the CLI's and desktop's update checks. Read with
 * `envFlag` (`@texra-ai/harness/node`), so `=0` / `=false` leave the check on.
 */
export const UPDATE_CHECK_SKIP_ENV = 'TEXRA_NO_UPDATE_CHECK';

/** The global root's update-check record of each host, keyed by the host. */
export const UPDATE_CHECKS: ValueFamily<UpdateCheckRecord> = {
  name: 'update-check',
  schema: UpdateCheckRecordSchema,
  deletable: false,
};

/** Each host's last update check and the last release it announced. */
export class UpdateCheckRecords extends Context.Service<
  UpdateCheckRecords,
  {
    readonly read: (
      host: UpdateCheckHost,
    ) => Effect.Effect<UpdateCheckRecord | null, Error>;
    readonly recordChecked: (
      host: UpdateCheckHost,
      at: number,
    ) => Effect.Effect<void, Error>;
    readonly recordNotified: (
      host: UpdateCheckHost,
      version: string,
    ) => Effect.Effect<void, Error>;
  }
>()('@texra/UpdateCheckRecords') {}

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
      const value = Predicate.isObject(body) ? body[field] : undefined;
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

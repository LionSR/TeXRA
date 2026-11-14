import { Clock, Duration, Effect, Predicate, Result, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { gt as semverGt, valid as semverValid } from 'semver';

import { withLogChannel } from '@texra-ai/harness/plugins';
import { GlobalValues, type ValueFamily } from '@texra-ai/harness/host';

import type { Cause } from 'effect';
import type { HttpClientError } from 'effect/http';

/** The hosts that check for updates, each with its own record. */
type UpdateCheckHost = 'cli' | 'desktop';

/** Persisted update notification state, isolated by host and configured storage root. */
const UpdateCheckRecordSchema = Schema.Struct({
  lastCheckedAt: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  lastNotifiedVersion: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1)),
  ),
});
type UpdateCheckRecord = typeof UpdateCheckRecordSchema.Type;

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
};

/** Change `host`'s update-check record, from an empty one when it has none. */
export const recordUpdateCheck = (
  host: UpdateCheckHost,
  change: Partial<UpdateCheckRecord>,
): Effect.Effect<void, Error, GlobalValues> =>
  Effect.flatMap(GlobalValues, (values) =>
    values.modify(UPDATE_CHECKS, host, (current) =>
      Result.succeed([
        undefined,
        {
          ...(current ?? { lastCheckedAt: null, lastNotifiedVersion: null }),
          ...change,
        },
      ] as const),
    ),
  );

/** Result of consulting an update source. */
export interface UpdateCheckFetchResult {
  /** Published version, when the source supplied one. */
  version: string | undefined;
  /** Whether the result came from a successful live refresh. */
  refreshed: boolean;
}

/** What a daily check found: the host announces it, then records the
 *  check, each as it decides. */
interface UpdateCheckFinding {
  /** The published release, when it is newer than this build. */
  readonly latest: string | undefined;
  /** The release this host last announced. */
  readonly lastNotifiedVersion: string | null;
  /** Stamp the check as done now; nothing when the source did not refresh. */
  readonly recordChecked: Effect.Effect<void, Error, GlobalValues>;
}

interface DailyUpdateCheckOptions<R> {
  currentVersion: string;
  host: UpdateCheckHost;
  fetchLatest: Effect.Effect<UpdateCheckFetchResult, Error, R>;
}

/** Consult the source, unless `host` checked within the day; undefined when
 *  it did, or the source named no release. */
export const runDailyUpdateCheck = Effect.fn('updateCheck.runDailyUpdateCheck')(
  function* <R>({
    currentVersion,
    host,
    fetchLatest,
  }: DailyUpdateCheckOptions<R>): Effect.fn.Return<
    UpdateCheckFinding | undefined,
    Error,
    R | GlobalValues
  > {
    const values = yield* GlobalValues;
    const previous = yield* values.get(UPDATE_CHECKS, host);
    const nowMs = yield* Clock.currentTimeMillis;
    if (
      previous?.lastCheckedAt != null &&
      nowMs - previous.lastCheckedAt < DAILY_UPDATE_CHECK_INTERVAL_MS
    )
      return undefined;

    const { version, refreshed } = yield* fetchLatest;
    if (version === undefined) return undefined;
    return {
      latest: isNewerSemverVersion(version, currentVersion)
        ? version
        : undefined,
      lastNotifiedVersion: previous?.lastNotifiedVersion ?? null,
      recordChecked: refreshed
        ? recordUpdateCheck(host, { lastCheckedAt: nowMs })
        : Effect.void,
    };
  },
);

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

import type { StateStore } from '@platform/interfaces';

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
  state: StateStore;
  lastCheckedAtKey: string;
  /** Persisted version used by hosts that notify only once per release. */
  lastNotifiedVersionKey?: string;
  fetchLatest: () => Promise<UpdateCheckFetchResult>;
  notify: (latest: string) => PromiseLike<void> | void;
  now?: () => number;
  /** Whether failure to persist the throttle stamp rejects the check. */
  stampFailure?: 'throw' | 'ignore';
}

/**
 * Run one daily-throttled update check.
 *
 * The throttle stamp is written only after a live source consultation and any
 * required notification. Thus network failures, stale local metadata, and
 * failed notifications all retry on the next launch. Hosts may additionally
 * persist the last notified version when a release should be announced only
 * once, independently of the daily fetch cadence.
 */
export async function runDailyUpdateCheck({
  currentVersion,
  state,
  lastCheckedAtKey,
  lastNotifiedVersionKey,
  fetchLatest,
  notify,
  now = Date.now,
  stampFailure = 'throw',
}: DailyUpdateCheckOptions): Promise<string | undefined> {
  const lastCheckedAt = state.get<number>(lastCheckedAtKey, 0);
  const nowMs = now();
  if (nowMs - lastCheckedAt < DAILY_UPDATE_CHECK_INTERVAL_MS) return undefined;

  const { version, refreshed } = await fetchLatest();
  if (version === undefined) return undefined;

  const latest = isNewerSemverVersion(version, currentVersion)
    ? version
    : undefined;
  const alreadyNotified =
    latest !== undefined &&
    lastNotifiedVersionKey !== undefined &&
    state.get<string>(lastNotifiedVersionKey) === latest;

  if (latest !== undefined && !alreadyNotified) {
    await notify(latest);
    if (lastNotifiedVersionKey !== undefined) {
      await state.update(lastNotifiedVersionKey, latest);
    }
  }

  if (refreshed) {
    if (stampFailure === 'ignore') {
      try {
        await state.update(lastCheckedAtKey, nowMs);
      } catch {
        // CLI throttle persistence is best-effort; a read-only state store
        // must not invalidate an update result that was already accepted.
      }
    } else {
      await state.update(lastCheckedAtKey, nowMs);
    }
  }

  return latest;
}

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
export async function fetchJsonStringField({
  url,
  field,
  timeoutMs,
  headers,
  fetchImpl = fetch,
}: FetchJsonStringFieldOptions): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    if (!response.ok) return undefined;

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return undefined;
    const value = (body as Record<string, unknown>)[field];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    // AbortError (timeout), TypeError (network), and SyntaxError (invalid JSON)
    // all make this best-effort update source unavailable for the current run.
    return undefined;
  }
}

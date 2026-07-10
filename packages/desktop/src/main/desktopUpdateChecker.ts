import { gt as semverGt, valid as semverValid } from 'semver';

import { GlobalStateKey } from '@shared/state/stateKeys';
import type { StateStore } from '@platform/interfaces';

/**
 * Lightweight desktop update check (issue #7682, decision: arm b).
 *
 * Polls the public `texra-ai/texra-desktop-releases` repo's latest GitHub
 * release and, when it is newer than the running build, hands the release
 * off to a caller-supplied `notify` callback (a native dialog with a
 * download link — see `createWindow` in `index.ts`). Deliberately NOT a full
 * updater: no download, no install, no feed files. Disable entirely with
 * `TEXRA_NO_UPDATE_CHECK=1`, mirroring the CLI's `updateChecker.ts`.
 */

const RELEASES_API_URL =
  'https://api.github.com/repos/texra-ai/texra-desktop-releases/releases/latest';
const FETCH_TIMEOUT_MS = 5000;
/** Poll at most once per day so a normal multi-launch day makes one request. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_SKIP_ENV = 'TEXRA_NO_UPDATE_CHECK';

export interface DesktopLatestRelease {
  /** Release version with any leading `v` stripped, e.g. `0.40.0`. */
  version: string;
  /** GitHub release page URL — installers are attached there. */
  url: string;
}

/**
 * True when `latest` is strictly newer than `current` under semver
 * precedence. Unparseable input yields `false` so a malformed API response
 * can never trigger a bogus update notification.
 */
export function isNewerDesktopVersion(
  latest: string,
  current: string,
): boolean {
  const a = semverValid(latest.trim(), { loose: true });
  const b = semverValid(current.trim(), { loose: true });
  if (!a || !b) return false;
  return semverGt(a, b);
}

/** Fetch the latest release's version + page URL, or undefined on any failure. */
export async function fetchLatestDesktopRelease(options?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<DesktopLatestRelease | undefined> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(RELEASES_API_URL, {
      signal: AbortSignal.timeout(options?.timeoutMs ?? FETCH_TIMEOUT_MS),
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
    };
    const tag = typeof body.tag_name === 'string' ? body.tag_name : undefined;
    const url = typeof body.html_url === 'string' ? body.html_url : undefined;
    if (!tag || !url) return undefined;
    return { version: tag.replace(/^v/, ''), url };
  } catch {
    return undefined;
  }
}

export interface CheckForDesktopUpdateOptions {
  currentVersion: string;
  globalState: StateStore;
  /** Skip entirely for unpackaged/dev runs, whose version is not meaningful. */
  isPackaged: boolean;
  notify: (release: DesktopLatestRelease) => Promise<void> | void;
  now?: () => number;
  fetchRelease?: typeof fetchLatestDesktopRelease;
  env?: NodeJS.ProcessEnv;
}

/**
 * Once per day (persisted in global state) and once per process, check for a
 * newer desktop release and notify at most once per release version. Failures
 * are silent so a flaky network never interrupts startup.
 */
export async function checkForDesktopUpdate({
  currentVersion,
  globalState,
  isPackaged,
  notify,
  now = Date.now,
  fetchRelease = fetchLatestDesktopRelease,
  env = process.env,
}: CheckForDesktopUpdateOptions): Promise<void> {
  if (!isPackaged) return;
  if (env[UPDATE_CHECK_SKIP_ENV]) return;

  const lastCheckedAt = globalState.get<number>(
    GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT,
    0,
  );
  const nowMs = now();
  if (nowMs - lastCheckedAt < CHECK_INTERVAL_MS) return;
  await globalState.update(
    GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT,
    nowMs,
  );

  const release = await fetchRelease();
  if (!release || !isNewerDesktopVersion(release.version, currentVersion)) {
    return;
  }

  const lastNotifiedVersion = globalState.get<string>(
    GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_NOTIFIED_VERSION,
  );
  if (lastNotifiedVersion === release.version) return;

  await notify(release);
  await globalState.update(
    GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_NOTIFIED_VERSION,
    release.version,
  );
}

import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  DAILY_UPDATE_CHECK_INTERVAL_MS,
  isNewerSemverVersion,
  UPDATE_CHECK_SKIP_ENV,
} from '@utils/system/semverUpdateCheck';
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
/**
 * Known-constant releases page, always opened verbatim instead of the
 * unauthenticated API response's `html_url` — see `notify` wiring in
 * `index.ts`. Never build a URL to open from network-provided data.
 */
export const DESKTOP_RELEASES_PAGE_URL =
  'https://github.com/texra-ai/texra-desktop-releases/releases';
/** Stable identifier for GitHub API request logging/diagnostics. */
const GITHUB_USER_AGENT = 'TeXRA-Desktop';
const FETCH_TIMEOUT_MS = 5000;
/** Poll at most once per day so a normal multi-launch day makes one request. */
const CHECK_INTERVAL_MS = DAILY_UPDATE_CHECK_INTERVAL_MS;

interface DesktopLatestRelease {
  /** Release version with any leading `v` stripped, e.g. `0.40.0`. */
  version: string;
}

/** Fetch the latest release's version, or undefined on any failure. */
export async function fetchLatestDesktopRelease(options?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<DesktopLatestRelease | undefined> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(RELEASES_API_URL, {
      signal: AbortSignal.timeout(options?.timeoutMs ?? FETCH_TIMEOUT_MS),
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': GITHUB_USER_AGENT,
      },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { tag_name?: unknown };
    const tag = typeof body.tag_name === 'string' ? body.tag_name : undefined;
    if (!tag) return undefined;
    return { version: tag.replace(/^v/, '') };
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

let desktopUpdateCheckInFlight: Promise<void> | undefined;
let desktopUpdateCheckNotify:
  CheckForDesktopUpdateOptions['notify'] | undefined;

/**
 * At most once per day (persisted in global state), check for a newer
 * desktop release and notify at most once per release version. The daily
 * throttle stamp is only persisted after a successful fetch and any required
 * notification, so a failed check retries on the next launch instead of being
 * suppressed for a full day. Concurrent callers share one process-level check.
 */
export function checkForDesktopUpdate(
  options: CheckForDesktopUpdateOptions,
): Promise<void> {
  // Window recreation may call again while the fetch is pending. Keep the
  // newest callback so any eventual dialog is parented to the live window.
  desktopUpdateCheckNotify = options.notify;
  if (desktopUpdateCheckInFlight) return desktopUpdateCheckInFlight;

  const check = runDesktopUpdateCheck({
    ...options,
    notify: (release) => desktopUpdateCheckNotify?.(release),
  });
  const tracked = check.finally(() => {
    if (desktopUpdateCheckInFlight === tracked) {
      desktopUpdateCheckInFlight = undefined;
      desktopUpdateCheckNotify = undefined;
    }
  });
  desktopUpdateCheckInFlight = tracked;
  return tracked;
}

async function runDesktopUpdateCheck({
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

  const release = await fetchRelease();
  if (!release) return;

  // Notify at most once per release version; a matching-or-older release just
  // refreshes the throttle stamp below.
  if (
    isNewerSemverVersion(release.version, currentVersion) &&
    globalState.get<string>(
      GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_NOTIFIED_VERSION,
    ) !== release.version
  ) {
    await notify(release);
    await globalState.update(
      GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_NOTIFIED_VERSION,
      release.version,
    );
  }

  // Stamp the daily throttle only after a successful fetch and any required
  // notification, so a failed check retries on the next launch.
  await globalState.update(
    GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT,
    nowMs,
  );
}

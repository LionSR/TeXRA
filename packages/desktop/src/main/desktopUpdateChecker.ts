import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { UPDATE_CHECK_SKIP_ENV } from '@utils/system/semverUpdateCheck';
import { isEnvFlagEnabled } from '@utils/system/envFlags';
import {
  fetchJsonStringField,
  runDailyUpdateCheck,
} from '@utils/system/updateCheck';

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

interface DesktopLatestRelease {
  /** Release version with any leading `v` stripped, e.g. `0.40.0`. */
  version: string;
}

/** Fetch the latest release's version, or undefined on any failure. */
async function fetchLatestDesktopRelease(options?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<DesktopLatestRelease | undefined> {
  const tag = await fetchJsonStringField({
    url: RELEASES_API_URL,
    field: 'tag_name',
    timeoutMs: options?.timeoutMs ?? FETCH_TIMEOUT_MS,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': GITHUB_USER_AGENT,
    },
    fetchImpl: options?.fetchImpl,
  });
  return tag ? { version: tag.replace(/^v/, '') } : undefined;
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
  if (isEnvFlagEnabled(UPDATE_CHECK_SKIP_ENV, env)) return;

  await runDailyUpdateCheck({
    currentVersion,
    state: globalState,
    lastCheckedAtKey: GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_CHECKED_AT,
    lastNotifiedVersionKey:
      GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_NOTIFIED_VERSION,
    fetchLatest: async () => {
      const release = await fetchRelease();
      return { version: release?.version, refreshed: release !== undefined };
    },
    notify: (version) => notify({ version }),
    now,
  });
}

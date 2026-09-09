import { Effect } from 'effect';

import { ensureError } from '@utils/errors/errorMessage';
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
const fetchLatestDesktopRelease = () =>
  fetchJsonStringField({
    url: RELEASES_API_URL,
    field: 'tag_name',
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': GITHUB_USER_AGENT,
    },
  }).pipe(
    Effect.map((tag) => (tag ? { version: tag.replace(/^v/, '') } : undefined)),
  );

interface CheckForDesktopUpdateOptions {
  currentVersion: string;
  /** Skip entirely for unpackaged/dev runs, whose version is not meaningful. */
  isPackaged: boolean;
  notify: (release: DesktopLatestRelease) => Promise<void> | void;
  fetchRelease?: Effect.Effect<DesktopLatestRelease | undefined, Error>;
  env?: NodeJS.ProcessEnv;
}

let desktopUpdateCheckNotify:
  CheckForDesktopUpdateOptions['notify'] | undefined;

/** One check owns the work; later windows supply the current dialog parent. */
export const checkForDesktopUpdate = (options: CheckForDesktopUpdateOptions) =>
  Effect.suspend(() => {
    if (desktopUpdateCheckNotify !== undefined) {
      desktopUpdateCheckNotify = options.notify;
      return Effect.void;
    }
    desktopUpdateCheckNotify = options.notify;
    return runDesktopUpdateCheck({
      ...options,
      notify: (release) => desktopUpdateCheckNotify?.(release),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          desktopUpdateCheckNotify = undefined;
        }),
      ),
    );
  });

const runDesktopUpdateCheck = ({
  currentVersion,
  isPackaged,
  notify,
  fetchRelease = fetchLatestDesktopRelease(),
  env = process.env,
}: CheckForDesktopUpdateOptions) =>
  Effect.gen(function* () {
    if (!isPackaged || isEnvFlagEnabled(UPDATE_CHECK_SKIP_ENV, env)) return;
    yield* runDailyUpdateCheck({
      currentVersion,
      host: 'desktop',
      notifyOnce: true,
      fetchLatest: fetchRelease.pipe(
        Effect.map((release) => ({
          version: release?.version,
          refreshed: release !== undefined,
        })),
      ),
      notify: (version) =>
        Effect.tryPromise({
          try: async () => {
            await notify({ version });
          },
          catch: ensureError,
        }),
    });
  });

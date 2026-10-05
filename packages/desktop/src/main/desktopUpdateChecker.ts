import { Effect } from 'effect';

import { updateCheckRecordsLayer } from '@texra/controllers/session/updateCheckRecords';
import { UPDATE_CHECK_SKIP_ENV } from '@texra/utils/system/semverUpdateCheck';
import {
  fetchJsonStringField,
  runDailyUpdateCheck,
} from '@texra/utils/system/updateCheck';
import { envFlag } from '@utils/system/envFlags';
import { ensureError } from '@utils/errors/errorMessage';
import type { HttpClient } from 'effect/http';

/**
 * Lightweight desktop update check (issue #7682, decision: arm b).
 *
 * Polls the public `texra-ai/texra-desktop-releases` repo's latest GitHub
 * release and, when it is newer than the running build, hands the release
 * off to a caller-supplied `notify` callback (a native dialog with a
 * download link — see `announceRelease` in `desktopWindowHost.ts`). Deliberately NOT a full
 * updater: no download, no install, no feed files. Disable entirely with
 * `TEXRA_NO_UPDATE_CHECK=1`, mirroring the CLI's `updateChecker.ts`.
 */

const RELEASES_API_URL =
  'https://api.github.com/repos/texra-ai/texra-desktop-releases/releases/latest';
/**
 * Known-constant releases page, always opened verbatim instead of the
 * unauthenticated API response's `html_url` — see `notify` wiring in
 * `desktopWindowHost.ts`. Never build a URL to open from network-provided data.
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
  fetchRelease?: Effect.Effect<
    DesktopLatestRelease | undefined,
    Error,
    HttpClient.HttpClient
  >;
}

/** One check. The window that runs it owns it: it stops when that window
 * closes, and the next window checks again. */
export const checkForDesktopUpdate = ({
  currentVersion,
  isPackaged,
  notify,
  fetchRelease = fetchLatestDesktopRelease(),
}: CheckForDesktopUpdateOptions) =>
  Effect.gen(function* () {
    if (!isPackaged || (yield* envFlag(UPDATE_CHECK_SKIP_ENV))) return;
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
    }).pipe(Effect.provide(updateCheckRecordsLayer));
  });

import { gt as semverGt, valid as semverValid } from 'semver';

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
export function isNewerSemverVersion(latest: string, current: string): boolean {
  const a = semverValid(latest.trim(), { loose: true });
  const b = semverValid(current.trim(), { loose: true });
  if (!a || !b) return false;
  return semverGt(a, b);
}

/** Poll for updates at most once per day. */
export const DAILY_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Env var that disables both the CLI's and desktop's update checks. Read with
 * `isEnvFlagEnabled` (see `envFlags.ts`), so `=0` / `=false` leave the check on.
 */
export const UPDATE_CHECK_SKIP_ENV = 'TEXRA_NO_UPDATE_CHECK';

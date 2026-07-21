import escapeRegExp from 'escape-string-regexp';
import type { PlatformSecrets } from '@platform/secrets';
import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { unique } from '@utils/core';
import type { ErrorEvent } from '@sentry/electron/main';

export const DESKTOP_CRASH_REPORTING_DSN_SECRET =
  'texra.desktop.crashReporting.dsn';

const REDACTED_PATH = '<redacted-path>';

export interface DesktopCrashReportingStatus {
  enabled: boolean;
  configured: boolean;
}

export interface DesktopCrashReportingInitOptions {
  globalState: StateStore;
  secrets: PlatformSecrets;
  sensitivePaths: readonly (string | undefined)[];
  log?: Pick<Console, 'debug' | 'error'>;
}

type CrashEvent = ErrorEvent;

function pathVariants(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) return [];
  const forward = trimmed.replaceAll('\\', '/');
  const backward = forward.replaceAll('/', '\\');
  return unique([trimmed, forward, backward]);
}

function buildPathScrubbers(paths: readonly (string | undefined)[]): RegExp[] {
  return paths
    .flatMap((path) => (path ? pathVariants(path) : []))
    .filter((path) => path.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((path) => new RegExp(escapeRegExp(path), 'gi'));
}

function scrubString(value: string, scrubbers: readonly RegExp[]): string {
  return scrubbers.reduce(
    (current, scrubber) => current.replace(scrubber, REDACTED_PATH),
    value,
  );
}

function scrubValue(value: unknown, scrubbers: readonly RegExp[]): unknown {
  if (typeof value === 'string') {
    return scrubString(value, scrubbers);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, scrubbers));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        scrubString(key, scrubbers),
        scrubValue(entry, scrubbers),
      ]),
    );
  }
  return value;
}

export function scrubDesktopCrashEvent(
  event: CrashEvent,
  sensitivePaths: readonly (string | undefined)[],
): CrashEvent | null {
  return createDesktopCrashEventScrubber(sensitivePaths)(event);
}

function createDesktopCrashEventScrubber(
  sensitivePaths: readonly (string | undefined)[],
): (event: CrashEvent) => CrashEvent | null {
  const scrubbers = buildPathScrubbers(sensitivePaths);
  return (event) => {
    if (event.platform !== 'native') return null;
    return scrubValue(event, scrubbers) as CrashEvent;
  };
}

export async function getDesktopCrashReportingStatus(
  globalState: StateStore,
  secrets: PlatformSecrets,
): Promise<DesktopCrashReportingStatus> {
  return {
    enabled: globalState.get(
      GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED,
      false,
    ),
    configured: (await secrets.get(DESKTOP_CRASH_REPORTING_DSN_SECRET)) != null,
  };
}

export async function setDesktopCrashReportingEnabled(
  globalState: StateStore,
  enabled: boolean,
): Promise<void> {
  await globalState.update(
    GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED,
    enabled,
  );
}

export async function setDesktopCrashReportingDsn(
  secrets: PlatformSecrets,
  dsn: string | undefined,
): Promise<void> {
  const trimmed = dsn?.trim();
  if (trimmed) {
    await secrets.set(DESKTOP_CRASH_REPORTING_DSN_SECRET, trimmed);
  } else {
    await secrets.delete(DESKTOP_CRASH_REPORTING_DSN_SECRET);
  }
}

export async function initializeDesktopCrashReporting({
  globalState,
  secrets,
  sensitivePaths,
  log = console,
}: DesktopCrashReportingInitOptions): Promise<boolean> {
  const enabled = globalState.get(
    GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED,
    false,
  );
  if (!enabled) {
    log.debug?.('Desktop crash reporting disabled.');
    return false;
  }

  const dsn = await secrets.get(DESKTOP_CRASH_REPORTING_DSN_SECRET);
  if (!dsn) {
    log.debug?.('Desktop crash reporting enabled without a Sentry DSN.');
    return false;
  }

  const scrubCrashEvent = createDesktopCrashEventScrubber(sensitivePaths);

  try {
    const sentry = await import('@sentry/electron/main');
    sentry.init({
      dsn,
      tracesSampleRate: 0,
      attachScreenshot: false,
      beforeSend: (event) => scrubCrashEvent(event),
    });
    return true;
  } catch (error) {
    log.error?.('Failed to initialize desktop crash reporting', error);
    return false;
  }
}

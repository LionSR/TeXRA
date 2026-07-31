import escapeRegExp from 'escape-string-regexp';
import { unique } from '@utils/core';
import type { ErrorEvent } from '@sentry/electron/main';

const REDACTED_PATH = '<redacted-path>';

export interface DesktopCrashReportingInitOptions {
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

/**
 * Native crash capture is a developer-build affordance: it turns on only when
 * TEXRA_SENTRY_DSN is set in the environment, and there is no UI for it.
 */
export async function initializeDesktopCrashReporting({
  sensitivePaths,
  log = console,
}: DesktopCrashReportingInitOptions): Promise<void> {
  const dsn = process.env.TEXRA_SENTRY_DSN?.trim();
  if (!dsn) {
    log.debug?.('Desktop crash reporting disabled: TEXRA_SENTRY_DSN unset.');
    return;
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
  } catch (error) {
    log.error?.('Failed to initialize desktop crash reporting', error);
  }
}

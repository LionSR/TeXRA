import { createDesktopCrashEventScrubber } from './desktopCrashEventScrubber.js';

export interface DesktopCrashReportingInitOptions {
  sensitivePaths: readonly (string | undefined)[];
  log?: Pick<Console, 'debug' | 'error'>;
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

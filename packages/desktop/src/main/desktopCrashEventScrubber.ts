import escapeRegExp from 'escape-string-regexp';
import { pathSeparatorVariants } from './desktopPathVariants.js';
import type { ErrorEvent } from '@sentry/electron/main';

const REDACTED_PATH = '<redacted-path>';

function scrubValue(value: unknown, scrubbers: readonly RegExp[]): unknown {
  if (typeof value === 'string') {
    return scrubbers.reduce(
      (current, scrubber) => current.replace(scrubber, REDACTED_PATH),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, scrubbers));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        scrubbers.reduce(
          (current, scrubber) => current.replace(scrubber, REDACTED_PATH),
          key,
        ),
        scrubValue(entry, scrubbers),
      ]),
    );
  }
  return value;
}

export function createDesktopCrashEventScrubber(
  sensitivePaths: readonly (string | undefined)[],
): (event: ErrorEvent) => ErrorEvent | null {
  const scrubbers = sensitivePaths
    .flatMap((path) => (path ? pathSeparatorVariants(path) : []))
    .filter((path) => path.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((path) => new RegExp(escapeRegExp(path), 'gi'));
  return (event) => {
    if (event.platform !== 'native') return null;
    return scrubValue(event, scrubbers) as ErrorEvent;
  };
}

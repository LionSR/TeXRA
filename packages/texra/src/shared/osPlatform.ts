/**
 * The host's operating system as the app tells them apart: macOS, Windows,
 * and everything else as Linux. Browser-safe, so the webviews and the desktop
 * renderer read the same union the Node side narrows `process.platform` into.
 */

// Third-party imports
import { Schema } from 'effect';

/** The three operating systems the app distinguishes. */
export const OsPlatformSchema = Schema.Literals(['darwin', 'win32', 'linux']);
export type OsPlatform = typeof OsPlatformSchema.Type;

/** A Node platform id (`process.platform`) as an {@link OsPlatform}; one
 *  the app does not tell apart (`freebsd`, …) reads as Linux. */
export function osPlatformOf(raw: string): OsPlatform {
  return raw === 'darwin' || raw === 'win32' ? raw : 'linux';
}

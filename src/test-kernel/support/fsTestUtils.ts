/**
 * Shared filesystem assertions and error factories for suites exercising
 * real-filesystem behavior.
 */

// Node imports
import { stat } from 'node:fs/promises';

/**
 * Whether `path` exists on disk. Non-ENOENT stat failures (permissions,
 * I/O) propagate — a path that cannot be inspected is not "absent".
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Builds an `Error` carrying an errno-style `code` (e.g. 'ENOENT'). */
export function errnoError(
  code: string,
  message = code,
): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

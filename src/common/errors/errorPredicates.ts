/** Check if an error represents a file-not-found condition. */
export function isFileNotFoundError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'ENOENT' || code === 'FileNotFound';
}

/** Check if an error represents "a parent path component is a file, not a directory". */
export function isNotADirectoryError(err: unknown): boolean {
  return (err as { code?: string })?.code === 'ENOTDIR';
}

/** Check if an error represents a "no space left on device" condition. */
export function isDiskFullError(err: unknown): boolean {
  for (
    let current: unknown = err;
    current != null && typeof current === 'object';
    current = (current as { cause?: unknown }).cause
  ) {
    if ((current as { code?: string }).code === 'ENOSPC') return true;
  }
  return false;
}

/** Check if an error represents a file-not-found condition. */
export function isFileNotFoundError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'ENOENT' || code === 'FileNotFound';
}

/** Check if an error represents "a parent path component is a file, not a directory". */
export function isNotADirectoryError(err: unknown): boolean {
  return (err as { code?: string })?.code === 'ENOTDIR';
}

/** Check if an error is "dynamic import couldn't find the module" (Node + ESM variants). */
export function isModuleNotFoundError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/** `err` followed by its `cause` chain, outermost first. Shared traversal for
 *  predicates/metadata lookups that may be attached at any depth of a wrapped
 *  error's cause chain. */
export function causeChain(err: unknown): unknown[] {
  // Ad-hoc wrapping can produce circular causes (err.cause === err); guard so
  // a lookup in an error path cannot itself hang the process.
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  for (
    let current: unknown = err;
    current != null && typeof current === 'object' && !seen.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    seen.add(current);
    chain.push(current);
  }
  return chain;
}

/** Walks `err` and its `cause` chain, returning the first defined result of
 *  `extract`, or `undefined` if none of the nodes match. */
export function findInCauseChain<T>(
  err: unknown,
  extract: (node: unknown) => T | undefined,
): T | undefined {
  for (const current of causeChain(err)) {
    const result = extract(current);
    if (result !== undefined) return result;
  }
  return undefined;
}

/** Check if an error represents a "no space left on device" condition. */
export function isDiskFullError(err: unknown): boolean {
  return causeChain(err).some(
    (current) => (current as { code?: string }).code === 'ENOSPC',
  );
}

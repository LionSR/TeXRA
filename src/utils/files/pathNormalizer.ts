import * as path from 'path';

const PATH_SEPARATORS = /[\\/]/;

export const normalizeRunRelative = (target: string) => {
  const normalized = target === '.' ? '' : target;
  return normalized
    ? normalized.split(path.sep).filter(Boolean).join(path.sep)
    : '';
};

export const decodePathComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const isSafePathSegment = (segment: string) => {
  if (!segment) return false;
  const decoded = decodePathComponent(segment);
  if (path.posix.isAbsolute(segment) || path.win32.isAbsolute(segment))
    return false;
  if (PATH_SEPARATORS.test(segment) || PATH_SEPARATORS.test(decoded))
    return false;
  const normalized = path.normalize(decoded);
  return !(
    normalized.startsWith('..') ||
    normalized.includes(`..${path.sep}`) ||
    normalized === '..' ||
    decoded.includes('..')
  );
};

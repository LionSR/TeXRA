// Third-party imports

// Local imports - none

export const normaliseArxivIdentifier = (value: string): string =>
  value
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//, '')
    .replace(/\.pdf$/i, '');

export const extractEntryIdentifier = (rawId: unknown): string | null => {
  if (typeof rawId !== 'string') {
    return null;
  }
  const [, id] = rawId.split('/abs/');
  return id ? normaliseArxivIdentifier(id) : null;
};

export const getAuthorNames = (
  authors: unknown,
  maxAuthors?: number,
): string[] => {
  const list = Array.isArray(authors) ? authors : authors ? [authors] : [];
  const names = list
    .map((entry) => {
      if (entry && typeof entry === 'object' && 'name' in entry) {
        const value = (entry as { name?: unknown }).name;
        return typeof value === 'string' ? value : null;
      }
      return typeof entry === 'string' ? entry : null;
    })
    .filter((name): name is string => Boolean(name));
  if (typeof maxAuthors === 'number') {
    return names.slice(0, maxAuthors);
  }
  return names;
};

export const readPrimaryCategory = (primary: unknown): string | null => {
  if (!primary) {
    return null;
  }
  if (typeof primary === 'string') {
    return primary;
  }
  if (typeof primary === 'object' && primary && 'term' in primary) {
    const { term } = primary as { term?: unknown };
    return typeof term === 'string' ? term : null;
  }
  return null;
};

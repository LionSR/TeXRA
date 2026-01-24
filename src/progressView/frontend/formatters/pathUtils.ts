export const getBasename = (filePath: string): string => {
  if (!filePath) return '';
  const normalized = filePath.replaceAll('\\', '/');
  const parts = normalized.split('/');
  return parts.at(-1) ?? '';
};

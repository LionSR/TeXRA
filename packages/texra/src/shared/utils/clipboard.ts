export function appendClipboardImageChips(
  text: string,
  fileNames: readonly string[],
): string {
  if (fileNames.length === 0) return text;
  const boundary =
    text && !text.endsWith(' ') && !text.endsWith('\n') ? ' ' : '';
  return `${text}${boundary}${fileNames.map((name) => `[${name}]`).join(' ')}`;
}

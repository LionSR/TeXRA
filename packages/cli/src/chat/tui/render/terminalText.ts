import stringWidth from 'string-width';

export function textDisplayWidth(text: string): number {
  return stringWidth(text);
}

export function clipToWidth(text: string, width: number): string {
  let clipped = '';
  for (const char of text) {
    if (textDisplayWidth(clipped + char) > width) break;
    clipped += char;
  }
  return clipped;
}

/**
 * Pad every visual row out to `width` display columns.
 *
 * Ink only paints backgrounds and inverse-video spans behind glyphs it draws,
 * so padding extends bands across the full row. `textDisplayWidth` keeps wide
 * glyphs and emoji aligned.
 */
export function fillRows(text: string, width: number): string {
  return text
    .split('\n')
    .map((row) => row + ' '.repeat(Math.max(0, width - textDisplayWidth(row))))
    .join('\n');
}

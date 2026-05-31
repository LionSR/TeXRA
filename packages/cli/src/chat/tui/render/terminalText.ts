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

/**
 * Text with every line break as `\n`: CRLF (Windows) and a lone CR (classic
 * Mac, a progress bar's carriage return) both become LF, the way markdown-it
 * reads its input. `splitContentLines` in `@texra-ai/harness/schemas` handles
 * CRLF only.
 */
export function normalizeLineEndings(text: string): string {
  return text.replaceAll(/\r\n?/g, '\n');
}

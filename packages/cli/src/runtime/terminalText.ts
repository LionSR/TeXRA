import stripAnsi from 'strip-ansi';

const UNSAFE_TERMINAL_CONTROLS =
  // eslint-disable-next-line no-control-regex -- terminal output must exclude C0/C1 controls
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Remove terminal control sequences while preserving printable text and line breaks. */
export function safeTerminalText(text: string): string {
  return stripAnsi(text)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\t', '  ')
    .replaceAll(UNSAFE_TERMINAL_CONTROLS, '');
}

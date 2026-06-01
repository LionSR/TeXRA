export function dumbTerminalMessage(
  command: string,
  options: { nonInteractiveFallback?: string } = {},
): string {
  const fallback =
    options.nonInteractiveFallback == null
      ? ''
      : ` For non-interactive runs, use ${options.nonInteractiveFallback}.`;
  return `texra ${command} needs a capable terminal: TERM=dumb disables the cursor controls Ink uses. If this is an interactive PTY, prefix the command with \`TERM=xterm-256color\`.${fallback}`;
}

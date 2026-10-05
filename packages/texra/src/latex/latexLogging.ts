/**
 * Shared log channel for host-neutral LaTeX tooling.
 *
 * Every module that shells out to a local LaTeX command-line tool (tex-fmt,
 * latexindent, texcount, latexdiff, …) logs under this one channel so a single
 * log filter (`LaTeXCommands`) covers the whole family. Keep the string here —
 * it is a stable, user-facing log channel name and must not drift across the
 * sites.
 */
export const LATEX_COMMANDS_CHANNEL = 'LaTeXCommands';

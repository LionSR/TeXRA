import { Context } from 'effect';

/**
 * Where a long LaTeX operation (an arXiv download, a directory's
 * indentation) reports its progress: a message, and how far along it is.
 * A host that shows progress provides it for the operation's scope (the
 * extension's notification); by default nothing listens, as for a tool call.
 */
export const LatexProgress = Context.Reference<
  (message: string, increment?: number) => void
>('@texra/latex/LatexProgress', { defaultValue: () => () => undefined });

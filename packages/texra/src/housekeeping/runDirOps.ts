import type { FileOpResult } from '@shared/schemas';

/** What a host tells the user after a pack or clean, at which severity.
 *  Both hosts read it from here, so the wording cannot drift between them
 *  (the latexdiff pack's counterpart is `latexdiffPackMessage`). */
export function fileOpResultMessage(
  operation: 'pack' | 'clean',
  result: FileOpResult,
  inputFile: string,
): { readonly level: 'info' | 'error'; readonly text: string } {
  const gerund = operation === 'pack' ? 'packing' : 'cleaning';
  switch (result.status) {
    case 'success':
      if (operation === 'clean')
        return { level: 'info', text: `Cleanup complete for ${inputFile}` };
      return {
        level: 'info',
        text: result.outputFolder
          ? `Files packed into ${result.outputFolder}`
          : 'Files packed.',
      };
    case 'noFiles':
      return {
        level: 'info',
        text: `No files found to ${operation} for ${inputFile}`,
      };
    case 'missingParams':
      return { level: 'error', text: `Select an input file before ${gerund}.` };
    case 'error':
      return {
        level: 'error',
        text: `Error during ${gerund}: ${result.error}`,
      };
  }
}

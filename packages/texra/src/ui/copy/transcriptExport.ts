/**
 * How a transcript export reads in every host: the format pick, why a task
 * has nothing to export, and the notice that says what was written.
 */

export const TRANSCRIPT_EXPORT_COPY = Object.freeze({
  /** How every host's format pick is titled and what it asks. */
  pick: Object.freeze({
    title: 'Export transcript',
    prompt: 'Choose a format',
  }),
  /** The formats a pick offers, in the order it lists them. */
  formats: Object.freeze([
    Object.freeze({
      format: 'html',
      label: 'HTML',
      description: 'Shareable webpage',
    }),
    Object.freeze({
      format: 'md',
      label: 'Markdown',
      description: 'Plain-text conversation',
    }),
    Object.freeze({
      format: 'tex',
      label: 'PDF',
      description: 'Formatted via LaTeX',
    }),
  ] as const),
  /** Why a task has nothing to export, in every format. */
  unavailable: Object.freeze({
    no_record: 'This task has no saved data to export.',
    no_rows: 'No conversation was saved for this task.',
  }),
  exported: (fileName: string) => `Transcript exported: ${fileName}`,
  compiled: (fileName: string) =>
    `Transcript exported and compiled: ${fileName}`,
  compileFailed:
    'LaTeX compilation failed. The .tex source file has been opened instead.',
});

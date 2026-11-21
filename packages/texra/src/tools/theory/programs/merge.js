import { revise } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'merge',
    system:
      "You merge the changes of an edited LaTeX document into its original. You keep the original's structure and formatting and incorporate every edit.",
    intro:
      "Create one complete LaTeX document from the original document and its edited version below. Keep the original's structure, so that a diff of the two versions shows only the edits.",
    requests: [
      'Where the edited version says a part is unchanged or leaves it out, copy that part from the original verbatim. Where it shows an edit or an addition, incorporate it exactly as written, in place of the corresponding part of the original. Keep every section header, equation, figure, table, macro and comment in its place; where the edited version is ambiguous, keep the original. Before you answer, check that every edit is in and nothing else changed. Output the complete merged document.',
    ],
  });

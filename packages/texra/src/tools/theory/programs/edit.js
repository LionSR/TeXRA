import { revise, LATEX } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'edit',
    system:
      "You edit LaTeX research papers. Make only the changes the instruction asks for. With no instruction, proofread: correct typos, grammar and LaTeX formatting, and leave the claims, the mathematics and the authors' style as they are.\n\n" +
      LATEX,
    intro: 'Read the following LaTeX research documents before editing them.',
    requests: [
      'Edit the documents as the instruction asks, to the extent it asks: a proofread changes wording and formatting only, a polish may rewrite sentences and paragraphs for clarity and flow, and a request for new or expanded content adds it with every derivation step shown. Do not change text the instruction does not concern. Write plain technical English: concrete statements, plain verbs, each point made once.',
      'Review your changes against the original and the instruction, then output the corrected documents. Revert any change the instruction did not ask for. Restore mathematics, equations or reasoning that went missing. Fix notation used before it is defined, and remove sentences that say nothing specific. If a change holds up, leave it alone; if nothing needs fixing, reproduce the documents unchanged.',
    ],
  });

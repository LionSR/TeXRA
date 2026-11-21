import { revise, LATEX, ANNOTATIONS } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'enhance',
    system:
      'You improve the substance of research papers: you make the improvements you can carry out in full, and leave a \\criticize annotation where an improvement needs the authors.\n\n' +
      LATEX,
    intro:
      'The following LaTeX documents need improvement. Read the full collection, appendices included, before you change anything.',
    requests: [
      'Improve the documents in the respect the instruction names (for example the mathematical content, the logical structure of the argument, or the consistency of the notation); with none, look for simpler proofs, stronger results and gaps in the mathematics. Make each improvement you can carry out completely and correctly, showing every step of new mathematics. Where an improvement is larger than you can finish, or needs a decision from the authors, leave the text as it is and add an annotation that starts with "Suggestion:". Mark each change you made with an annotation that starts with "Implemented:".\n\n' +
        ANNOTATIONS,
      'Verify every change you made: rederive new mathematics step by step, check that each change is consistent with the rest of the documents, and revert any that does not hold. Then output the complete documents.',
    ],
  });

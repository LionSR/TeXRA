import { revise, addsOnly, ANNOTATIONS, CRITICIZE } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'annotate',
    system:
      'You review research papers by adding \\criticize annotations to them. You never rewrite: outside your annotations, every document you return is the input, character for character.',
    intro:
      'The following LaTeX documents need review. Read every document, appendices included, before you annotate.',
    requests: [
      'Review the documents from the point of view the instruction names; with none, as a careful referee of the mathematics. Work through each derivation and claim yourself before you judge it, and annotate every point that needs action: errors, gaps, unsupported or overstated claims, undefined terms, and inconsistencies between the documents. Rate each by its severity and your confidence. Return every document complete, with your annotations inserted and nothing else changed.\n\n' +
        ANNOTATIONS,
      'Check each annotation you added: verify the claim behind it again, correct its severity and confidence, remove the ones that do not hold, and add any you missed. Return every document complete, with the annotations inserted and nothing else changed.',
    ],
    // What a prompt can only ask for, checked: the diff adds annotations only.
    verify: addsOnly('\\criticize', CRITICIZE),
  });

import { revise, LATEX } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'apply',
    system:
      'You implement the fixes that inline annotations from an earlier review ask for (\\criticize{comment}{severity}{confidence}, \\todo{}, \\comment{} or % comments). The instruction decides which annotations to handle; with none, handle them all. Understand each issue, work through any mathematics it needs, and apply the fix; remove an annotation once it is handled or when its severity is 0.\n\n' +
      LATEX,
    intro:
      'The following LaTeX documents contain inline annotations from an earlier review. Read every document and locate every annotation.',
    requests: [
      'Apply the annotations: correct errors directly, write out missing steps and derivations in full, rewrite unclear passages in plain technical English, and resolve inconsistencies between the documents to one version. Do not use notation before the document defines it. Leave an annotation in place, unchanged, when the instruction excludes it or you cannot resolve it. Output the complete documents.',
    ],
  });

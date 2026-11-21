import { revise } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'poster',
    creates: true,
    templates: [
      'template_poster.tex',
      'beamercolorthemempi.sty',
      'beamerthemeconfposter.sty',
    ],
    system:
      'You turn research papers into mathematically detailed LaTeX Beamer posters for a scientific audience, written plainly and concretely.',
    intro:
      "Create a LaTeX Beamer poster from the research paper below. Use the poster template among the documents as its skeleton, with the template's theme and color scheme.",
    requests: [
      "Write a complete, self-contained poster with clear sections (abstract, introduction, framework, methods, results, discussion, conclusions), the paper's key equations and derivations, and compact references. Follow the instruction when there is one.",
      "Review the draft poster for mathematical accuracy, readability at poster size, compact references, use of the template's color scheme and plain, concrete phrasing. Fix what you find and output the complete poster; if nothing needs fixing, reproduce it unchanged.",
    ],
  });

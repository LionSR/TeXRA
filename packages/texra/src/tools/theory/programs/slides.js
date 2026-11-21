import { revise } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'slides',
    creates: true,
    templates: ['template_slide.tex'],
    system:
      'You turn research papers into LaTeX Beamer presentations for a scientific audience. Each slide makes one point; every bullet states a specific fact, method or result in plain words.',
    intro:
      'Create a LaTeX Beamer presentation from the research paper below. Use the template among the documents as its skeleton.',
    requests: [
      "Write a complete, self-contained deck of 10 to 15 slides: introduction, the paper's methods and key results with their equations, and a conclusion slide. Follow the instruction when there is one.",
      "Review the draft deck for the accuracy of the paper's claims, slide organization, equation formatting and plain, concrete phrasing. Fix what you find and output the complete deck; if nothing needs fixing, reproduce it unchanged.",
    ],
  });

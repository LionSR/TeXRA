/**
 * The task programs: jobs a person or the entry agent starts by name, each
 * one child agent told that job's rubric and given the tools it needs. The
 * rubric is what makes each a program: what to check, in what order, and
 * what to hand back.
 *
 * `task.js` is the module they share; each program's own module, a file of
 * `programs/`, names its rubric and tools and calls it. They are built into
 * this table as their text.
 */
import type { Program } from '@texra-ai/harness/plugins';

import task from './task.js?raw';
import review from './programs/review.js?raw';
import search from './programs/search.js?raw';
import derive from './programs/derive.js?raw';
import code from './programs/code.js?raw';
import reviewCode from './programs/review-code.js?raw';
import simplify from './programs/simplify.js?raw';
import testTask from './programs/test.js?raw';
import experiment from './programs/experiment.js?raw';
import solve from './programs/solve.js?raw';
import fixLatex from './programs/fix-latex.js?raw';
import latexdiff from './programs/latexdiff.js?raw';

/** Each program: its listing line and its module. */
const TASKS = {
  review: {
    description:
      'Audit a manuscript (`inputFiles`) for correct mathematics, sound derivations, consistent notation, code that matches the text, and goals it actually reaches; answers with a report and edits nothing unless the instruction asks.',
    module: review,
  },
  search: {
    description:
      'Find and synthesize literature and web sources for the question in the instruction, with citations; it adds to Zotero and downloads arXiv sources but edits no workspace file.',
    module: search,
  },
  derive: {
    description:
      'Carry out an analytical derivation or symbolic computation for the instruction, with Wolfram Language through `wolframscript` where it helps, and verify the result.',
    module: derive,
  },
  code: {
    description:
      "Implement a feature, make a targeted edit or fix a bug in the project's code, then run its build and tests; answers with what changed and the output that shows it works.",
    module: code,
  },
  'review-code': {
    description:
      'Review a diff or the named files for correctness, clarity, security and fit with the project; answers with prioritized findings and edits nothing.',
    module: reviewCode,
  },
  simplify: {
    description:
      'Simplify working code or LaTeX for clarity and reuse without changing what it does, then confirm the tests or the build still pass.',
    module: simplify,
  },
  test: {
    description:
      "Write or repair tests for the named code with the project's own framework: pin down existing behavior, cover new code and edge cases, and run them.",
    module: testTask,
  },
  experiment: {
    description:
      'Design, run and validate a numerical experiment (a simulation, a solver, a parameter sweep, a reproduction of a figure) and report what it shows.',
    module: experiment,
  },
  solve: {
    description:
      'Attack a research-level or open problem: survey what is known, experiment on small cases, search for counterexamples, and write a rigorous proof, disproof or clearly scoped partial result.',
    module: solve,
  },
  'fix-latex': {
    description:
      'Diagnose and fix LaTeX compilation errors, broken references and citations, warnings and bad boxes in the named files so the document builds.',
    module: fixLatex,
  },
  latexdiff: {
    description:
      'Produce a compiled visual diff of two versions of a LaTeX document with `latexdiff`: the old and new files are `inputFiles`, or the instruction names them.',
    module: latexdiff,
  },
} satisfies Record<string, { description: string; module: string }>;

/** The script modules: `task`, and one per program. */
export const TASK_MODULES: Readonly<Record<string, string>> = Object.freeze({
  task,
  ...Object.fromEntries(
    Object.entries(TASKS).map(([name, { module }]) => [name, module]),
  ),
});

/** The modules that are programs, each over an instruction and optional
 *  `inputFiles`, answering with its child's reply. */
export const TASK_PROGRAMS: Readonly<Record<string, Program>> = Object.freeze(
  Object.fromEntries(
    Object.entries(TASKS).map(([name, { description }]) => [
      name,
      Object.freeze({ description, tools: Object.freeze(['agent']) }),
    ]),
  ),
);

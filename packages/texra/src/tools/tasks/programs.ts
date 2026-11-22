/**
 * The task programs: jobs a person or the entry agent starts by name, each
 * one child agent told that job's rubric and given the tools it needs. The
 * rubric is what makes each a program: what to check, in what order, and
 * what to hand back.
 *
 * `task.js` is the module they share; each program's own module only names
 * its rubric and tools, so it is written from the table below.
 */
import type { Program } from '@texra-ai/harness/plugins';

import task from './task.js?raw';

const FILES = ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash'];
const READ_ONLY = ['read_file', 'glob', 'grep', 'bash'];

/** Each program: its listing line, its child's system text and tools. */
const TASKS = {
  review: {
    description:
      'Audit a manuscript (`inputFiles`) for correct mathematics, sound derivations, consistent notation, code that matches the text, and goals it actually reaches; answers with a report and edits nothing unless the instruction asks.',
    tools: [...FILES, 'arxiv_search', 'diagnostics'],
    system: [
      'Audit the manuscript: read all of it with its bibliography, appendices, preamble and any source code, and work through it section by section. Coverage beats speed.',
      'Reproduce every key derivation step by step and check limiting cases, dimensions, and stated bounds or solutions by substitution; verify substantive numbers and prefactors independently. Compute (wolframscript or a short Python script through bash) only where it adds evidence.',
      'Check that each symbol is defined before use and means one thing, that labels and references resolve, that every goal the abstract and introduction state is carried through, that code matches the text in signs, index ranges, boundary conditions and parameters, that figures and tables agree with the text, and that a claim attributed to a reference matches the cited work.',
      'Do not edit files unless the instruction asks. Answer with a report by category (goals, mathematics, notation, code, figures and tables, references, summary): cite the exact equation, section or line, show the check behind each finding, give the incorrect and the correct version of an error, and separate confirmed errors from points that need clarification.',
    ],
  },
  search: {
    description:
      'Find and synthesize literature and web sources for the question in the instruction, with citations; it adds to Zotero and downloads arXiv sources but edits no workspace file.',
    tools: [
      ...READ_ONLY,
      'arxiv_search',
      'download_arxiv_source',
      'zotero_add',
      'zotero_search',
      'zotero_export',
      'web_search',
      'web_fetch',
    ],
    system: [
      'Find and synthesize information from the web and the academic literature, and base every conclusion on a source you inspected. Cross-check sources, present disagreement as disagreement, and cite each with its URL, DOI or arXiv ID, saying whether it is peer-reviewed, a preprint or a web page, and its date.',
      'Download a paper only when asked or when it needs detailed reading, and then prefer its arXiv source over a PDF. Read a long source by section, and report its path, line count and section offsets.',
      'Before adding to Zotero, check the library or the project .bib files for the title or DOI; add with explicit metadata and the right item type.',
      'Do not create or edit workspace files: the download and Zotero tools are your only writes, and bash is for read-only commands.',
    ],
  },
  derive: {
    description:
      'Carry out an analytical derivation or symbolic computation for the instruction, with Wolfram Language through `wolframscript` where it helps, and verify the result.',
    tools: FILES,
    system: [
      'State the problem and outline the approach, then derive. Show each manipulation with its intermediate algebra and define notation before using it.',
      "Run Wolfram Language through bash (`wolframscript -code '...'` or `-file script.wl`; each run is a fresh session). Verify before presenting: substitute test values, take limiting cases, check dimensions, and spot-check numerically.",
      'A file you write is read without this conversation: write it as its author, self-contained.',
    ],
  },
  code: {
    description:
      "Implement a feature, make a targeted edit or fix a bug in the project's code, then run its build and tests; answers with what changed and the output that shows it works.",
    tools: [...FILES, 'diagnostics'],
    system: [
      "Implement the change in the project's code so that it reads like the code already there: read the files you will change in full, match their idiom, reuse existing helpers, and make the smallest change that does the job.",
      'For a failure, reproduce it first, fix the root cause, and rerun the failing case and the tests around it. In numerical code suspect units, signs, indexing, broadcasting, boundary conditions, tolerances and seeds before the framework. If you cannot reproduce it, say so.',
      "Before you finish, run the project's build and tests and check diagnostics; fix what you broke, name a failure that was already there, and remove scratch files. Report the files you changed, the gist of each edit, and the command output that proves it, including anything that failed or was skipped.",
    ],
  },
  'review-code': {
    description:
      'Review a diff or the named files for correctness, clarity, security and fit with the project; answers with prioritized findings and edits nothing.',
    tools: [...READ_ONLY, 'diagnostics'],
    system: [
      'Review the change and report what matters; do not edit files. Establish what changed (the named files or diff, otherwise `git diff` and `git status`) and read enough around it to know its callers and invariants.',
      'Correctness first: in numerical code look for wrong signs or units, off-by-one indexing, broadcasting, boundary conditions, tolerances and unseeded randomness. Then clarity, security, and fit with the conventions of the code around it.',
      'Answer with findings in priority order, each with its file and line, why it matters, and a concrete fix; separate what must change from suggestions, and say so when you found nothing.',
    ],
  },
  simplify: {
    description:
      'Simplify working code or LaTeX for clarity and reuse without changing what it does, then confirm the tests or the build still pass.',
    tools: [...FILES, 'diagnostics'],
    system: [
      'Make working code or LaTeX simpler and clearer without changing its behavior, results or meaning. Remove duplication (prefer an existing helper to a new abstraction), dead code, redundant branches, needless indirection, and wrappers with one caller; check that two blocks really serve one purpose before merging them.',
      'This is not a bug hunt: report a bug you find, do not fix it under a refactor. Prefer explicit, readable code to a compact trick.',
      'Run the tests or the build before and after, and report what you changed and the output that shows nothing else did.',
    ],
  },
  test: {
    description:
      "Write or repair tests for the named code with the project's own framework: pin down existing behavior, cover new code and edge cases, and run them.",
    tools: [...FILES, 'diagnostics'],
    system: [
      "Write tests that catch real regressions, in the project's existing framework, layout and naming; add no second framework. Read the code under test in full so each assertion states what it does and should do.",
      'Cover the behavior that matters, keep tests deterministic and fast, and reuse fixtures. For numerical code assert with a justified tolerance, fix seeds, and test limiting and known analytic cases.',
      'Run the tests. A test that fails because the code is wrong is a finding to report, not a test to weaken. Report what you added and the run output.',
    ],
  },
  experiment: {
    description:
      'Design, run and validate a numerical experiment (a simulation, a solver, a parameter sweep, a reproduction of a figure) and report what it shows.',
    tools: FILES,
    system: [
      'Follow the scientific method in code: state the question and what would count as an answer, form a hypothesis from a limiting case or a back-of-envelope estimate before running, and then run.',
      'Validate before you trust a result: a known analytic case, a convergence check in resolution or step size, conserved quantities, and sensitivity to seeds and tolerances. Keep parameters in one place, fix seeds, and record the command that produced each number or figure.',
      'Report the result with its uncertainty, how it compares with the hypothesis, what you validated, and what remains unchecked.',
    ],
  },
  solve: {
    description:
      'Attack a research-level or open problem: survey what is known, experiment on small cases, search for counterexamples, and write a rigorous proof, disproof or clearly scoped partial result.',
    tools: [
      ...FILES,
      'web_search',
      'web_fetch',
      'arxiv_search',
      'download_arxiv_source',
    ],
    system: [
      'Restate the problem precisely first: define every object, resolve ambiguities explicitly, and say what counts as a solution and what as partial progress. Then establish what the literature already has.',
      'Experiment before proving: compute small cases, look for patterns, and search for counterexamples to the statement and to each conjecture you form along the way.',
      'Deliver verifiable progress: a proof or disproof when you have one, otherwise a special case, a reduction, an improved bound or a verified computational range. Write every step so it can be checked, mark each gap as a gap, and never present a heuristic as a proof.',
    ],
  },
  'fix-latex': {
    description:
      'Diagnose and fix LaTeX compilation errors, broken references and citations, warnings and bad boxes in the named files so the document builds.',
    tools: [
      'read_file',
      'edit_file',
      'glob',
      'grep',
      'bash',
      'diagnostics',
      'executions',
    ],
    system: [
      'Make the document build, with its references, bibliography and hyperlinks. Compile with `latexmk -pdf -interaction=nonstopmode <file>` to get a log (many undefined-reference and rerun messages need only a full rebuild), then fix one issue at a time and recompile to confirm: errors first, then references, citations and hyperref, then warnings and bad boxes.',
      'Keep edits minimal and in place. Never rewrite or replace a file wholesale, change mathematical content, delete content to silence an error, or invent a reference. Regenerable artifacts (.aux, .bbl from a .bib, .bcf, .blg) may be deleted to force a rebuild; sources may not.',
      "Files under `/executions/` are a run's output: read them with the `executions` tool and do not copy them over workspace files. If the failure comes from how the compile was invoked and not from the source, report that and stop. Summarize what you changed.",
    ],
  },
  latexdiff: {
    description:
      'Produce a compiled visual diff of two versions of a LaTeX document with `latexdiff`: the old and new files are `inputFiles`, or the instruction names them.',
    tools: ['read_file', 'edit_file', 'glob', 'grep', 'bash', 'executions'],
    system: [
      "Run `latexdiff` on the two versions and compile the diff so added and removed text shows inline. A version under `/executions/` is a run's output that only the `executions` tool reads: stage it into a temporary directory first, since `latexdiff` and bash need real paths.",
      'Write the diff beside the newer version under a name that says it is a diff, and never over a source file. If the diff does not compile, fix the diff file (math and floats are the usual cause; `--math-markup` and `--exclude-safecmd` help), not the sources.',
      'Answer with the path of the diff PDF and anything the diff could not show.',
    ],
  },
} satisfies Record<
  string,
  { description: string; tools: readonly string[]; system: readonly string[] }
>;

/** The script modules: `task`, and one per program that names its rubric
 *  and tools. */
export const TASK_MODULES: Readonly<Record<string, string>> = Object.freeze({
  task,
  ...Object.fromEntries(
    Object.entries(TASKS).map(([name, { system, tools }]) => [
      name,
      `import { task } from 'builtIn:task';\n\nexport default (args, launch) =>\n  task(${JSON.stringify({ name, system: system.join('\n\n'), tools })}, launch);\n`,
    ]),
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

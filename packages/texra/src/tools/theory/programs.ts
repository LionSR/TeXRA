/**
 * The theory plugin's programs: the script modules a person or a model
 * starts by name to revise documents, and the module they share,
 * `builtIn:revise`. A program's run asks no model itself. It calls
 * `revise`, which runs one child agent per request (`agent()`), takes the
 * documents out of each reply, compiles and diffs them with the document
 * tools (`../documents/documentTools`), and ends by proposing the last
 * revision. What differs between programs is here: the child's system text,
 * the requests, a check of each revision, the templates a revision reads
 * and whether the program writes new documents.
 *
 * Each module is a file of `programs/`, built into this table as its text.
 * A step records the module sources it ran, so a resumed run replays the
 * program it started with.
 */
import type { Program } from '@texra-ai/worldline/plugins';
import type { DocumentsOutput } from '@texra/shared/plugins/documents';
import { DOCUMENT_TASK_RESULT } from '@texra/tools/documents/documentResult';

import annotate from './programs/annotate.js?raw';
import apply from './programs/apply.js?raw';
import edit from './programs/edit.js?raw';
import enhance from './programs/enhance.js?raw';
import poster from './programs/poster.js?raw';
import revise from './programs/revise.js?raw';
import slides from './programs/slides.js?raw';
import transcribe from './programs/transcribe.js?raw';

/** What every program's run is offered: the child agent and the document
 *  tools `revise` calls. */
const TOOLS = Object.freeze([
  'agent',
  'document_context',
  'document_extract',
  'document_compile',
  'document_diff',
  'document_review',
  'document_propose',
] as const);

/** A program's registration: its `description`, with the tools and result
 *  reading every theory program shares. */
const program = (
  description: string,
  outputs?: readonly string[],
): Program<DocumentsOutput> =>
  Object.freeze({
    description,
    tools: TOOLS,
    result: DOCUMENT_TASK_RESULT,
    ...(outputs !== undefined && { outputs: Object.freeze(outputs) }),
  });

/** The theory plugin's script modules, by name: `revise`, which the
 *  programs share, and one per program. */
export const THEORY_MODULES = Object.freeze({
  revise,
  edit,
  annotate,
  enhance,
  apply,
  transcribe,
  slides,
  poster,
});

/**
 * The modules that are programs, each over `inputFiles` with an optional
 * instruction. A point of view (the argument's logic, the notation, a first
 * reader) is a sentence of the instruction, not a program.
 */
export const THEORY_PROGRAMS = Object.freeze({
  edit: program(
    'Rewrite the documents as the instruction asks, from a proofread to new content; with no instruction, proofread.',
  ),
  annotate: program(
    'Review the documents by adding `\\criticize{}` annotations; never rewrites. The instruction names the point of view.',
  ),
  enhance: program(
    'Improve the substance (mathematics, logic or notation, as the instruction names): makes the changes it can, annotates the rest.',
  ),
  apply: program(
    'Implement the fixes that inline annotations from an earlier review ask for.',
  ),
  transcribe: program(
    'Turn `mediaFiles` (handwriting or scans, or audio) into a LaTeX document.',
    ['transcript.tex'],
  ),
  slides: program(
    'Turn a paper into a Beamer slide deck on the bundled template.',
    ['slides.tex'],
  ),
  poster: program(
    'Turn a paper into a Beamer poster on the bundled template.',
    ['poster.tex'],
  ),
} satisfies Record<string, Program<DocumentsOutput>>);

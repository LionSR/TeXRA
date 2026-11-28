/**
 * The theory plugin's programs. `annotate` reviews LaTeX files by adding
 * `\criticize` annotations: a child per round edits the files in place,
 * and the program checks in code that nothing outside the annotations
 * changed before it ends or starts the next round. `transcribe` starts one
 * child with the launch's media attached, which writes them as a LaTeX
 * file.
 *
 * Each module is a file of `programs/`, built into this table as its text.
 * A step records the module sources it ran, so a resumed run replays the
 * program it started with.
 */
import type { Program } from '@texra-ai/worldline/plugins';

import annotate from './programs/annotate.js?raw';
import transcribe from './programs/transcribe.js?raw';

/** The theory plugin's script modules, by name: one per program. */
export const THEORY_MODULES = Object.freeze({ annotate, transcribe });

/** The modules that are programs; each answers with its child's reply. */
export const THEORY_PROGRAMS = Object.freeze({
  annotate: Object.freeze({
    description:
      'Review the `.tex` files of `inputFiles` by adding `\\criticize{comment}{severity}{confidence}` annotations in place, checked to change nothing else; the instruction names the point of view.',
    tools: Object.freeze(['agent', 'read_file']),
  }),
  transcribe: Object.freeze({
    description:
      'Turn `mediaFiles` (handwriting or scans, or audio) into a new LaTeX file in the project, `transcript.tex` unless the instruction names another.',
    tools: Object.freeze(['agent']),
  }),
} satisfies Record<string, Program>);

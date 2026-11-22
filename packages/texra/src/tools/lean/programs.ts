/**
 * The lean4 plugin's programs: `prove` completes the proofs in Lean files
 * and `blueprint` writes or brings up to date a LeanBlueprint document. Each
 * runs one child agent per round, told the program's system text and given
 * the file, shell and Lean tools, and checks the round's work in code before
 * it ends or starts the next: `prove` with Lean's own diagnostics (no error,
 * no `sorry`) and the `axiom` declarations the files gained since the run
 * started (none), `blueprint` with the leanblueprint CLI's own build and
 * declaration check. The checks are what make them programs and not a sentence of a
 * prompt.
 *
 * Each module is a file of `programs/`, built into this table as its text.
 * A step records the module sources it ran, so a resumed run replays the
 * program it started with.
 */
import type { Program } from '@texra-ai/harness/plugins';

import blueprint from './programs/blueprint.js?raw';
import prove from './programs/prove.js?raw';
import rounds from './programs/rounds.js?raw';

/** The lean4 plugin's script modules, by name: `rounds`, which the
 *  programs share, and one per program. */
export const LEAN_MODULES = Object.freeze({ rounds, prove, blueprint });

/** The modules that are programs, each over `inputFiles` with an optional
 *  instruction; each answers with its check's verdict and its last round's
 *  reply. */
export const LEAN_PROGRAMS = Object.freeze({
  prove: Object.freeze({
    description:
      'Complete the proofs in the `.lean` files of `inputFiles` until Lean reports no error and no `sorry` and the files declare no new `axiom`; the instruction narrows which.',
    tools: Object.freeze(['agent', 'lean_file', 'lean_diagnostics']),
  }),
  blueprint: Object.freeze({
    description:
      'Write or bring up to date a LeanBlueprint document (its `.tex` files are `inputFiles`) until `leanblueprint web` and `leanblueprint checkdecls` pass. Needs the leanblueprint CLI.',
    tools: Object.freeze(['agent', 'bash']),
  }),
} satisfies Record<string, Program>);

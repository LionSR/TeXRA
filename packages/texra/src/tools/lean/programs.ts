/**
 * The lean4 plugin's programs: `prove` completes the proofs in Lean files,
 * `lean-simplify` brings them toward library quality without changing what
 * they prove, `blueprint` writes or brings up to date a LeanBlueprint
 * document, and `lean-search` finds what Mathlib and the project already
 * have (one child, built on the core plugin's `builtIn:task`). The others
 * each run one child agent per round, told the program's system text and given
 * the file, shell and Lean tools, and checks the round's work in code before
 * it ends or starts the next: `prove` and `lean-simplify` with Lean's own
 * diagnostics (no error, no `sorry`) and the `axiom` declarations the files
 * gained since the run started (none), `blueprint` with the leanblueprint CLI's own build and
 * declaration check. The checks are what make them programs and not a sentence of a
 * prompt.
 *
 * Each module is a file of `programs/`, built into this table as its text.
 * A step records the module sources it ran, so a resumed run replays the
 * program it started with.
 */
import type { Program } from '@texra-ai/harness/plugins';

import blueprint from './programs/blueprint.js?raw';
import leanSearch from './programs/lean-search.js?raw';
import leanSimplify from './programs/lean-simplify.js?raw';
import prove from './programs/prove.js?raw';
import rounds from './programs/rounds.js?raw';

/** The lean4 plugin's script modules, by name: `rounds`, which the
 *  programs share, and one per program. */
export const LEAN_MODULES = Object.freeze({
  rounds,
  prove,
  'lean-simplify': leanSimplify,
  blueprint,
  'lean-search': leanSearch,
});

/** The modules that are programs. The round programs work over
 *  `inputFiles` with an optional instruction and answer with their check's
 *  verdict and their last round's reply; `lean-search` takes an
 *  instruction and answers with its child's reply. */
export const LEAN_PROGRAMS = Object.freeze({
  prove: Object.freeze({
    description:
      'Complete the proofs in the `.lean` files of `inputFiles` until Lean reports no error and no `sorry` and the files declare no new `axiom`; the instruction narrows which.',
    tools: Object.freeze(['agent', 'lean_file', 'lean_diagnostics']),
  }),
  'lean-simplify': Object.freeze({
    description:
      'Bring the `.lean` files of `inputFiles` toward Mathlib quality (names, style, generality, simpler proofs, library lemmas instead of hand-written ones) without changing what they state, until Lean reports no error and no `sorry` and they declare no new `axiom`.',
    tools: Object.freeze(['agent', 'lean_file', 'lean_diagnostics']),
  }),
  'lean-search': Object.freeze({
    description:
      'Find what Mathlib and the project already have for the statement, API or formalization question in the instruction, with names, types and imports, and say what is missing; edits no file unless asked.',
    tools: Object.freeze(['agent']),
  }),
  blueprint: Object.freeze({
    description:
      'Write or bring up to date a LeanBlueprint document (its `.tex` files are `inputFiles`) until `leanblueprint web` and `leanblueprint checkdecls` pass. Needs the leanblueprint CLI.',
    tools: Object.freeze(['agent', 'bash']),
  }),
} satisfies Record<string, Program>);

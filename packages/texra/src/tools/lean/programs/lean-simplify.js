/**
 * The `lean-simplify` program: rounds of a child agent that bring Lean
 * files toward library quality without changing what they prove, until Lean
 * reports them clean and they declare no new axiom (`builtIn:rounds`).
 */
import { leanCheck, rounds, statedAxioms } from 'builtIn:rounds';

const SIMPLIFIER = [
  'You refactor Lean 4 files toward Mathlib quality: clear, general, well named and consistent with the library. Never change what a declaration states or computes, only how it is written; every theorem statement, instance and value stays as it is.',
  "Read the files and the project's AGENTS.md first, and use the tactics and automation it lists. Then work in this order: naming and style (Mathlib's compositional names, 100-character lines, docstrings on public declarations, minimal imports, scoped opens), generality (the weakest typeclass the proof needs, `@[to_additive]` instead of parallel copies), proof simplification (explicit simp sets, `omega`, `gcongr`, `positivity`, `norm_num`, `ring`, a `calc` where it shows the structure), and duplication (a helper lemma, or the Mathlib lemma that already exists: search with lean_loogle and grep before you keep a hand-written one).",
  'Make one logical change per edit. After every edit call lean_file on the file, then lean_diagnostics, and undo an edit that introduces an error; no sorry, admit or new axiom. Keep comments that explain the mathematics and readable proofs that a shorter tactic would hide. When the project pairs the Lean files with LaTeX notes, report where a statement, a definition or a proof outline disagrees with them, but change only the Lean side.',
  'Your answer goes to the person who started the program: what you changed and why, in a few sentences, and anything you left as it was.',
].join('\n\n');

export default async (args, launch) => {
  const stated = await statedAxioms(launch.inputFiles);
  return rounds(
    {
      name: 'lean-simplify',
      system: SIMPLIFIER,
      tools: [
        'read_file',
        'edit_file',
        'glob',
        'grep',
        'bash',
        'lean_diagnostics',
        'lean_inspect',
        'lean_file',
        'lean_project',
        'lean_loogle',
      ],
      rounds: 2,
      extension: '.lean',
      describes: 'the .lean files to simplify',
      fallback:
        'Simplify these files toward Mathlib quality without changing what they prove.',
      check: leanCheck(stated),
    },
    launch,
  );
};

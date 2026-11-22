import { leanCheck, rounds, statedAxioms } from 'builtIn:rounds';

const PROVER = [
  'You complete formal proofs in a Lean 4 project. Work out the mathematics first: understand each statement, find the argument, and write a short informal outline before you write tactics.',
  'Find what the library already has before you prove it yourself: lean_loogle searches Mathlib by type signature or name pattern (it takes several queries at once), and when the project has a .lake/packages directory, grep and glob read Mathlib and the other dependencies directly.',
  'Write a proof, then check the file, and repeat until Lean reports no error and no declaration that uses sorry. Lean reads a file only when it opens it, so after every edit call lean_file on the file before lean_diagnostics; otherwise the diagnostics describe the file as it was. lean_inspect shows the goal at a position. Do not leave sorry, admit or a new axiom in place of a proof.',
  "Keep every statement as it is: change a theorem's hypotheses or conclusion only when the instruction asks, and say so in your answer when a statement is false as written. Keep the project's names and conventions, and when its AGENTS.md lists tactics or automation, use them.",
  'Read a file before you edit it. Your answer goes to the person who started the program: say what you proved and how, in a few sentences with the mathematics in $...$, and name anything you could not finish.',
].join('\n\n');

export default async (args, launch) => {
  const stated = await statedAxioms(launch.inputFiles);
  return rounds(
    {
      name: 'prove',
      system: PROVER,
      tools: [
        'read_file',
        'write_file',
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
      rounds: 3,
      extension: '.lean',
      describes: 'the .lean files to complete',
      fallback:
        'Complete every proof in these files: replace each sorry with a proof and fix every error.',
      check: leanCheck(stated),
    },
    launch,
  );
};

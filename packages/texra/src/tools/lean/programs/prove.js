import { rounds } from 'builtIn:rounds';

const PROVER = [
  'You complete formal proofs in a Lean 4 project. Work out the mathematics first: understand each statement, find the argument, and write a short informal outline before you write tactics.',
  'Find what the library already has before you prove it yourself: lean_loogle searches Mathlib by type signature or name pattern (it takes several queries at once), and when the project has a .lake/packages directory, grep and glob read Mathlib and the other dependencies directly.',
  'Write a proof, then check the file, and repeat until Lean reports no error and no declaration that uses sorry. Lean reads a file only when it opens it, so after every edit call lean_file on the file before lean_diagnostics; otherwise the diagnostics describe the file as it was. lean_inspect shows the goal at a position. Do not leave sorry, admit or a new axiom in place of a proof.',
  "Keep every statement as it is: change a theorem's hypotheses or conclusion only when the instruction asks, and say so in your answer when a statement is false as written. Keep the project's names and conventions, and when its AGENTS.md lists tactics or automation, use them.",
  'Read a file before you edit it. Your answer goes to the person who started the program: say what you proved and how, in a few sentences with the mathematics in $...$, and name anything you could not finish.',
].join('\n\n');

/** Lean's verdict on file as it is on disk now: reopened, so Lean reads
 *  the child's edits, then asked again while Lean is still elaborating. */
const diagnose = async (file) => {
  await tools.lean_file({ file });
  for (let poll = 1; ; poll += 1) {
    const result = await tools.lean_diagnostics({ file });
    if (result.complete || poll === 5) return result;
  }
};

/** The axioms of after beyond those of before, each occurrence counted:
 *  one whose statement changed is a new one. */
const added = (before, after) => {
  const left = [...before];
  return after.filter((name) => {
    const at = left.indexOf(name);
    if (at !== -1) left.splice(at, 1);
    return at === -1;
  });
};

/** Whether Lean reports every file clean and none declares an axiom it did
 *  not declare in stated (each file's axioms when the program started), and
 *  what is still open. An axiom in place of a proof elaborates without an
 *  error or a sorry, so Lean's diagnostics alone would pass it. */
const checker = (stated) => async (files) => {
  const verdicts = [];
  for (const file of files) {
    const result = await diagnose(file);
    verdicts.push({
      file,
      result,
      unproved: !result.complete || result.errors > 0 || result.sorries > 0,
      axioms: added(stated[file] ?? [], result.axioms),
    });
  }
  const open = verdicts.filter(
    ({ unproved, axioms }) => unproved || axioms.length > 0,
  );
  if (open.length === 0)
    return {
      clean: true,
      report:
        'Lean reports no error and no sorry in ' +
        files.join(', ') +
        ', and no new axiom is declared there.',
    };
  return {
    clean: false,
    report: open
      .flatMap(({ file, result, unproved, axioms }) => [
        ...(unproved
          ? [
              '<diagnostics file="' +
                file +
                '" summary="' +
                result.summary +
                '">\n' +
                result.output +
                '\n</diagnostics>',
            ]
          : []),
        ...(axioms.length > 0
          ? [
              file +
                ' declares an axiom it did not before (' +
                axioms.join('; ') +
                "): an axiom is not a proof. Prove the statement, or restore the file's axioms and say what you could not prove.",
            ]
          : []),
      ])
      .join('\n'),
  };
};

export default async (args, launch) => {
  // Each file's axioms as the program found it: only one a round adds is
  // the round's doing.
  const stated = {};
  for (const file of launch.inputFiles.filter((name) =>
    name.endsWith('.lean'),
  )) {
    await tools.lean_file({ file });
    stated[file] = (
      await tools.lean_diagnostics({ file, command: 'count' })
    ).axioms;
  }
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
      check: checker(stated),
    },
    launch,
  );
};

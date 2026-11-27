/**
 * The module `builtIn:checked`, which the Lean programs that change files
 * are built on.
 *
 * `checked(task, launch)` starts one child, told `task.system` and given
 * `task.tools`, over the files of `launch.inputFiles` that end in
 * `task.extension`. The child works until it calls its work done; then
 * `task.check(files)` answers `{ clean, report }`, and the program answers
 * with that report and the child's reply. The program runs the check, so
 * what it reports does not depend on what the child says of its own work.
 *
 * `statedAxioms(files)` and `leanCheck(stated)` are the check of the
 * programs that change Lean files: Lean reports each file clean, and none
 * declares an axiom it did not declare when the program started.
 */

export const checked = async (
  { name, system, tools, extension, describes, fallback, check },
  { instruction, inputFiles, contextFiles },
) => {
  const files = inputFiles.filter((file) => file.endsWith(extension));
  const skipped = inputFiles.filter((file) => !file.endsWith(extension));
  if (files.length === 0)
    throw new Error(
      name +
        ' works on ' +
        extension +
        ' files: pass ' +
        describes +
        ' as inputFiles.',
    );
  const reply = await agent(
    [
      instruction.trim()
        ? '<instruction>\n' + instruction.trim() + '\n</instruction>'
        : fallback,
      'The files: ' + files.join(', ') + '.',
      ...(contextFiles.length > 0
        ? [
            'Read these for context and do not change them: ' +
              contextFiles.join(', ') +
              '.',
          ]
        : []),
    ].join('\n\n'),
    { system, tools, label: name, id: name },
  );
  const { clean, report } = await check(files);
  return [
    clean ? report : 'The work is not finished. The check reports:\n' + report,
    // A file the program does not work on is named, never dropped unsaid.
    ...(skipped.length > 0
      ? [
          'Not ' +
            extension +
            ' files, so not worked on: ' +
            skipped.join(', ') +
            '.',
        ]
      : []),
    reply.response,
  ].join('\n\n');
};

/** Each `.lean` file's axioms as the program found it: only one the child
 *  adds is its doing. */
export const statedAxioms = async (inputFiles) => {
  const stated = {};
  for (const file of inputFiles.filter((name) => name.endsWith('.lean'))) {
    await tools.lean_file({ file });
    stated[file] = (
      await tools.lean_diagnostics({ file, command: 'count' })
    ).axioms;
  }
  return stated;
};

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
export const leanCheck = (stated) => async (files) => {
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

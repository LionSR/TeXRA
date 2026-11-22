/**
 * The module `builtIn:rounds`, which both Lean programs are built on.
 *
 * `rounds(task, launch)` runs a fresh child per round, told `task.system`
 * and given `task.tools`, over the files of `launch.inputFiles` that end in
 * `task.extension`. After each round `task.check(files)` answers
 * `{ clean, report }`: the round ends the program when `clean`, and
 * otherwise the next round reads the report. It answers with the last
 * report and the child's last reply.
 *
 * `statedAxioms(files)` and `leanCheck(stated)` are the check of the
 * programs that change Lean files: Lean reports each file clean, and none
 * declares an axiom it did not declare when the program started.
 */

export const rounds = async (
  { name, system, tools, rounds, extension, describes, fallback, check },
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
  const task = [
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
  ].join('\n\n');
  // A file the program does not work on is named, never dropped unsaid.
  const answer = (verdict, reply) =>
    [
      verdict,
      ...(skipped.length > 0
        ? [
            'Not ' +
              extension +
              ' files, so not worked on: ' +
              skipped.join(', ') +
              '.',
          ]
        : []),
      reply,
    ].join('\n\n');
  let checked = null;
  let reply = null;
  for (let round = 1; round <= rounds; round += 1) {
    const label = 'Round ' + round;
    section(label);
    const prompt =
      checked === null
        ? task
        : task +
          '\n\nAn earlier round left work to do. The check reports:\n' +
          checked.report;
    reply = await agent(prompt, {
      system,
      tools,
      label,
      id: 'round-' + round,
    });
    checked = await check(files);
    if (checked.clean) return answer(checked.report, reply.response);
  }
  return answer(
    'After ' + rounds + ' rounds the check still reports:\n' + checked.report,
    reply.response,
  );
};

/** Each `.lean` file's axioms as the program found it: only one a round
 *  adds is the round's doing. */
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

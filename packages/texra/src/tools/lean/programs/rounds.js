/**
 * The module `builtIn:rounds`, which both Lean programs are built on.
 *
 * `rounds(task, launch)` runs a fresh child per round, told `task.system`
 * and given `task.tools`, over the files of `launch.inputFiles` that end in
 * `task.extension`. After each round `task.check(files)` answers
 * `{ clean, report }`: the round ends the program when `clean`, and
 * otherwise the next round reads the report. It answers with the last
 * report and the child's last reply.
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
      agentName: name,
      persona: { prompt: system, tools },
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

/**
 * The module `builtIn:task`, which the task programs are built on.
 *
 * `task(spec, launch)` gives one child agent, told `spec.system` and given
 * `spec.tools`, the launch's instruction and files, and answers with the
 * child's reply.
 */

export const task = async (
  { name, system, tools },
  { instruction, inputFiles, contextFiles },
) => {
  if (!instruction.trim() && inputFiles.length === 0)
    throw new Error(name + ' needs an instruction or inputFiles.');
  const prompt = [
    ...(instruction.trim()
      ? ['<instruction>\n' + instruction.trim() + '\n</instruction>']
      : []),
    ...(inputFiles.length > 0
      ? ['The files: ' + inputFiles.join(', ') + '.']
      : []),
    ...(contextFiles.length > 0
      ? [
          'Read these for context and do not change them: ' +
            contextFiles.join(', ') +
            '.',
        ]
      : []),
  ].join('\n\n');
  const reply = await agent(prompt, { system, tools, label: name, id: name });
  return reply.response;
};

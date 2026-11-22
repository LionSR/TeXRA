/**
 * The module `builtIn:task`, which the task programs are built on.
 *
 * `task(spec, launch)` gives one child agent, told `spec.system` and given
 * `spec.tools`, the launch's instruction and files, and answers with the
 * child's reply. The launch's media (PDFs, images, audio) are attached to
 * the child's prompt.
 */

export const task = async (
  { name, system, tools },
  { instruction, inputFiles, contextFiles, mediaFiles },
) => {
  if (!instruction.trim() && inputFiles.length === 0 && mediaFiles.length === 0)
    throw new Error(name + ' needs an instruction, inputFiles or mediaFiles.');
  const prompt = [
    ...(instruction.trim()
      ? ['<instruction>\n' + instruction.trim() + '\n</instruction>']
      : []),
    ...(inputFiles.length > 0
      ? ['The files: ' + inputFiles.join(', ') + '.']
      : []),
    ...(mediaFiles.length > 0
      ? ['Attached: ' + mediaFiles.join(', ') + '.']
      : []),
    ...(contextFiles.length > 0
      ? [
          'Read these for context and do not change them: ' +
            contextFiles.join(', ') +
            '.',
        ]
      : []),
  ].join('\n\n');
  const reply = await agent(prompt, {
    system,
    tools,
    mediaFiles,
    label: name,
    id: name,
  });
  return reply.response;
};

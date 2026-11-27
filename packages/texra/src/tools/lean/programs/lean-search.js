/**
 * The `lean-search` program: one child agent that finds what Mathlib and
 * the project already have for a statement, an API or a formalization
 * question, and says what it found and what is missing. The launch's
 * instruction and files are the child's prompt.
 */

const system = [
  'You find what already exists before anyone formalizes it: lemmas in Mathlib and the Lean project, the API around a definition, the tactic for a goal, and the paper behind a result. Search several sources before you conclude that something does not exist.',
  'lean_loogle searches Mathlib by type signature, name pattern, subexpression or conclusion, several queries at once; try more than one formulation (arguments swapped, `↔` against `→`). When the project has .lake/packages, grep and glob read Mathlib and the other dependencies directly, which is faster for an exact name and shows the proofs around it. lean_inspect shows the type of an identifier or the goal at a position in the project, lean_diagnostics what a file reports (call lean_file first, since Lean reads a file only when it opens it). web_search and web_fetch reach the Lean and Mathlib documentation and the community discussion, and the papers on arXiv.',
  'Answer with what you found, in three groups: an exact match, a close match that needs adapting, and what is genuinely missing. Give each match its full name, its type and its import. For something missing, propose the most general statement, the Mathlib file it belongs in and the name its naming conventions give it. Say which queries and sources you tried.',
  'Do not change the project: write a file only when the instruction asks for a draft.',
].join('\n\n');

const tools = [
  'read_file',
  'write_file',
  'glob',
  'grep',
  'bash',
  'lean_diagnostics',
  'lean_file',
  'lean_inspect',
  'lean_loogle',
  'web_search',
  'web_fetch',
];

export default async (
  args,
  { instruction, inputFiles, contextFiles, mediaFiles },
) => {
  if (!instruction.trim() && inputFiles.length === 0 && mediaFiles.length === 0)
    throw new Error(
      'lean-search needs an instruction, inputFiles or mediaFiles.',
    );
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
    label: 'lean-search',
    id: 'lean-search',
  });
  return reply.response;
};

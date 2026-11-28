/**
 * The program `write-up`: a result someone worked out, written for a reader.
 * The launch names the working files that hold the argument, the file that
 * holds the exact statement claimed, and the note to write. One child, which
 * saw none of the work, writes the note from those files alone: what it
 * cannot follow from them, a reader could not either. Then the program
 * checks what a prompt can only ask for: the note states the claim as it
 * was given, whitespace aside, and the working files and the claim are what
 * they were when the program started.
 */
import { read } from 'builtIn:text';

const WRITER = [
  'You write up a mathematical result for a reader, from the working files of whoever found it. You were not there when it was worked out, and that is the point: the files are all a reader could be given, so a step you cannot follow from them is a step the note cannot yet justify.',
  'Read every working file before you write. The claim file holds the exact statement being claimed. State it in the note character for character, as its main result, and write the note in the notation that statement uses, defining each macro it needs. Never strengthen, weaken, specialise or reword it, and never change the working files or the claim file: the program that started you compares all of them with what they were. When the files do not prove the claim as stated, say so in your answer and write up what they do prove beside the unchanged claim, clearly marked as weaker.',
  'Open with the statement and what it says in plain words. Then give a map of the proof that a reader can stop after: the objects, and each main step with its precise statement and the idea behind it, every sentence literally true. Then the full argument. Give every intermediate statement a label, state its hypotheses in full, and begin each proof by naming the earlier results it uses, by \\ref, so the structure of the argument can be read off the text.',
  'Write for the reader the instruction names; with none, a researcher in the field who has not seen this project. Give a standard fact one line or a precise citation, and write out what is specific to this argument: the estimates, the order in which parameters are chosen, and where each hypothesis is used. Leave out the history of the work: attempts that failed, names the working files invented for their own bookkeeping, and anything about how the result was found.',
  'Do not smooth over a gap. Where a step does not follow from the working files and you cannot supply it, keep it visible in the note as \\textbf{[Gap: what is missing]}. Cite only a reference the working files give or that you confirmed against real metadata; never invent one.',
  'Write the note as one LaTeX document that compiles on its own, at the path the task names. When latexmk is installed, compile it and fix what the log reports.',
  'Your answer goes to the person who started the program, who will send the open points back to be worked on: the file you wrote, then every gap, and then the steps you are least sure of, most serious first.',
].join('\n\n');

/** text with each run of whitespace as one space: line breaks and
 *  indentation are not part of a statement. */
const spaced = (text) => text.replace(/\s+/g, ' ').trim();

/** The file a launch names in `args[key]`. */
const named = (args, key, holds) => {
  const file = args?.[key];
  if (typeof file !== 'string' || file.trim() === '')
    throw new Error(
      'write-up needs args.' + key + ': the path of ' + holds + '.',
    );
  return file;
};

export default async (args, { instruction, inputFiles, contextFiles }) => {
  const claim = named(args, 'claim', 'the file holding the exact statement');
  const note = named(args, 'note', 'the LaTeX file to write');
  if (inputFiles.length === 0)
    throw new Error(
      'write-up works from working files: pass the notes that hold the argument as inputFiles.',
    );
  const kept = [...new Set([claim, ...inputFiles])];
  if (kept.includes(note))
    throw new Error(
      'write-up writes a new file: ' + note + ' is one of the files to keep.',
    );
  const before = {};
  for (const file of kept) before[file] = await read(file);
  if (spaced(before[claim]) === '')
    throw new Error('write-up needs a statement: ' + claim + ' is empty.');
  const reply = await agent(
    [
      ...(instruction.trim()
        ? ['<instruction>\n' + instruction.trim() + '\n</instruction>']
        : []),
      'The claim, to state exactly as it is: ' + claim + '.',
      'The working files, to read and not change: ' +
        inputFiles.join(', ') +
        '.',
      ...(contextFiles.length > 0
        ? [
            'Read these for context and do not change them: ' +
              contextFiles.join(', ') +
              '.',
          ]
        : []),
      'Write the note at ' + note + '.',
    ].join('\n\n'),
    {
      system: WRITER,
      tools: [
        'read_file',
        'write_file',
        'edit_file',
        'glob',
        'grep',
        'bash',
        'web_search',
        'web_fetch',
      ],
      label: 'write-up',
      id: 'write-up',
    },
  );
  const changed = [];
  for (const file of kept)
    if ((await read(file)) !== before[file]) changed.push(file);
  // A note that cannot be read is the finding, with the reason it gave.
  let unstated = [];
  try {
    if (!spaced(await read(note)).includes(spaced(before[claim])))
      unstated = [
        note +
          ' does not state the claim as ' +
          claim +
          ' gives it. Compare the two before you rely on the note.',
      ];
  } catch (failure) {
    unstated = ['The note at ' + note + ' cannot be read: ' + failure.message];
  }
  return [
    ...unstated,
    ...(changed.length > 0
      ? [
          'These files were to stay as they were and differ now: ' +
            changed.join(', ') +
            '.',
        ]
      : []),
    reply.response,
  ].join('\n\n');
};

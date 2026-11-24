/**
 * The program `transcribe`: one child, with the launch's media attached to
 * its prompt, writes their content as a LaTeX file in the project with its
 * file tools.
 */

const TRANSCRIBER = [
  'You turn attached media into LaTeX. Images of handwriting or scans are pages of one text, in the order given: you write their content in the notation and style of the context files. Recordings are one session, in the order given: you transcribe the spoken words with speakers and timestamps, a short opening summary and logical sections, and write spoken mathematics as LaTeX equations.',
  'Write one LaTeX document that compiles on its own, as a new file in the project: the file the instruction names, or transcript.tex. Never overwrite a file that exists: check first, and when the name is taken choose a free one (transcript-2.tex) and say so. For images, use the document class, notation, environments and symbols of the context files when there are any. For a recording, open with a short summary of the topics, then write each utterance as "[HH:MM:SS] Speaker: text", grouped into sections; do not use markdown.',
  "Then review your transcription against the media and correct the file. For images, fix symbols you misread or that differ from the context files' notation, subscripts and superscripts, and environments. For a recording, fix misheard words, speaker labels, timestamps and equations. When latexmk is installed, compile the file and fix what the log reports.",
  'Your answer goes to the person who started the program: the file you wrote, and what you could not read or hear.',
].join('\n\n');

export default async (
  args,
  { instruction, inputFiles, contextFiles, mediaFiles },
) => {
  if (mediaFiles.length === 0)
    throw new Error(
      'transcribe works on media: pass the images, scans or recordings as mediaFiles.',
    );
  const context = [...inputFiles, ...contextFiles];
  const reply = await agent(
    [
      ...(instruction.trim()
        ? ['<instruction>\n' + instruction.trim() + '\n</instruction>']
        : []),
      'Transcribe the attached media: ' + mediaFiles.join(', ') + '.',
      ...(context.length > 0
        ? [
            'Read these for notation and style and do not change them: ' +
              context.join(', ') +
              '.',
          ]
        : []),
    ].join('\n\n'),
    {
      system: TRANSCRIBER,
      tools: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash'],
      mediaFiles,
      label: 'Transcription',
    },
  );
  return reply.response;
};

import { revise } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'transcribe',
    creates: true,
    system:
      'You turn attached media into LaTeX. Images of handwriting or scans are pages of one text, in the order given: you write their content in the notation and style of the context documents. Recordings are one session, in the order given: you transcribe the spoken words with speakers and timestamps, a short opening summary and logical sections, and write spoken mathematics as LaTeX equations.',
    intro:
      'Transcribe the attached media into one LaTeX document that compiles on its own. Any documents below are context for its notation and style.',
    requests: [
      'Write the document. For images, use the document class, notation, environments and symbols of the context documents when there are any. For a recording, open with a short summary of the topics, then write each utterance as "[HH:MM:SS] Speaker: text", grouped into sections; do not use markdown.',
      "Review your transcription against the media and output the final document. For images, fix symbols you misread or that differ from the context documents' notation, subscripts and superscripts, and environments. For a recording, fix misheard words, speaker labels, timestamps and equations.",
    ],
  });

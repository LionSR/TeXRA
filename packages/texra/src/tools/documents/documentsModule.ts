/**
 * The documents plugin's script module, `builtIn:documents`: its document
 * tasks as functions a `script` imports. It runs in the script's sandbox and
 * calls `document_task` as the script would, so each task is the same
 * child run, card and approval as a direct call.
 */
export const DOCUMENTS_MODULE = `
/** Run agentName's document task; resolves to its result, whose
 *  documents.outputs are the files it revised. args takes document_task's
 *  fields: prompt, inputFiles, contextFiles, mediaFiles, outputFiles, model,
 *  reflect, extractFigures, extractTikz. */
export const revise = (agentName, args = {}) => {
  if (typeof tools.document_task !== 'function')
    throw new Error('revise() calls document_task, which this script is not offered.');
  return tools.document_task({ prompt: '', ...args, agentName });
};

/** args for a task over what a finished task produced: each document's
 *  latest revision as an input file. A task lists a document once per
 *  round (r0/, r1/, ... in its run storage), so the last round's copy is
 *  the one taken, by its absolute path. */
export const from = (result, args = {}) => {
  const outputs = result?.documents?.outputs;
  if (!Array.isArray(outputs))
    throw new TypeError('from() takes the result of a task that ran to its end.');
  const latest = new Map();
  for (const output of [...outputs].sort((a, b) => a.round - b.round))
    latest.set(output.relativePath.replace(/^r\\d+[\\/\\\\]/, ''), output.absolutePath);
  return { ...args, inputFiles: [...latest.values()] };
};
`;

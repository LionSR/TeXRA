/**
 * The module `builtIn:revise`, which every theory program is built on.
 *
 * `revise(task)` runs `task.requests` in order, one revision each: every
 * revision is a fresh child told `task.system`, whose prompt is the
 * documents, the earlier requests with its replies, and this request. After
 * every revision but the last, `task.verify` (a function of the revision's
 * diffs, returning what is wrong or null) and, with `task.reflect`, a
 * critic told `task.review` may each add to what the next revision reads.
 * The rest of `task` goes to `document_context` as given.
 */

/** The \criticize annotation: its arguments, scale and definition. */
export const CRITICIZE = [
  '% The \\criticize annotation: \\criticize{comment}{severity}{confidence}.',
  '% Severity: 5 fatal (invalidates a main claim or result), 4 critical',
  '% (seriously weakens the paper), 3 major, 2 minor, 1 cosmetic, 0 verified',
  '% correct. Confidence: 1 (a guess) to 5 (certain).',
  '\\usepackage{xcolor}',
  '\\newcommand{\\criticize}[3]{\\ifmmode\\textcolor{\\ifnum#2=5 red\\else\\ifnum#2=4 orange\\else\\ifnum#2=3 yellow!80!red\\else\\ifnum#2=2 yellow!60!black\\else\\ifnum#2=0 green!60!black\\else gray\\fi\\fi\\fi\\fi\\fi!\\ifnum#3<3 30\\else\\ifnum#3<5 70\\else 100\\fi\\fi!black}{\\text{[#1 (S#2/C#3)]}}\\else\\textcolor{\\ifnum#2=5 red\\else\\ifnum#2=4 orange\\else\\ifnum#2=3 yellow!80!red\\else\\ifnum#2=2 yellow!60!black\\else\\ifnum#2=0 green!60!black\\else gray\\fi\\fi\\fi\\fi\\fi!\\ifnum#3<3 30\\else\\ifnum#3<5 70\\else 100\\fi\\fi!black}{[#1 (S#2/C#3)]}\\fi}',
].join('\n');

/** How to write a \criticize annotation, for a request that asks for them. */
export const ANNOTATIONS = [
  'Write each annotation as \\criticize{comment}{severity}{confidence}, placed where the issue is. Its comment is part of the document and must compile: escape special characters and close every brace and math delimiter. Say what is wrong and what would fix it. Its definition and scale follow; add the definition to the preamble if it is not already there:',
  CRITICIZE,
].join('\n');

/** What every revising child is told about the documents it returns. */
export const LATEX = [
  'When you write a LaTeX document:',
  '- Return each document complete, with every section in the order of the input.',
  '- Keep every LaTeX comment and every label; use the macros the preamble and the context files define, and do not redefine them.',
  '- Define notation and terminology before first use, and keep them consistent across the documents.',
  '- The document must stand on its own: its reader never sees this conversation.',
].join('\n');

/** What the critic between revisions is told. */
export const CRITIC = [
  'You review one revision of a LaTeX document that another agent is revising over several rounds. You are given the user\'s instruction when there is one (<instruction>), the requests the revision answered (<request>), the unified diff of each output against the document the task started from (<diff path="...">; for a document the task creates, such as slides or a transcript, the diff is the whole file), a <missing> note when the revision did not write every document, and its compile result (<compile>). Your review goes to the agent\'s next revision.',
  'Report two things, and nothing else:',
  '1. Corrections. Errors the revision introduced or kept within the diff and its context: wrong mathematics or derivation steps, broken logic, LaTeX that will not compile or renders wrongly, unsupported or overstated claims, and changes that contradict a request. Tie each one to a location (file and the line, equation, label, or a short quote) and say what is wrong and what is right. Report only what the evidence shows; if the diff is clean, say so. When the requests ask only for annotations inserted into otherwise unchanged text, state each correction as an annotation to add, revise or remove, never as an edit to the original text.',
  '2. One improvement. The single most valuable optional change the next revision could make to serve the requests better. One item, stated concretely.',
  'Be concise: a short numbered list of corrections, then one line for the improvement. Do not rewrite the document or quote large passages, and do not repeat compile errors beyond naming their cause.',
].join('\n\n');

/** text without its macro{...}{...} annotations, braces balanced. */
const without = (text, macro) => {
  let kept = '';
  let from = 0;
  for (;;) {
    const at = text.indexOf(macro + '{', from);
    if (at < 0) return kept + text.slice(from);
    kept += text.slice(from, at);
    let end = at + macro.length;
    while (text[end] === '{') {
      let depth = 0;
      do {
        if (text[end] === '\\') end += 1;
        else if (text[end] === '{') depth += 1;
        else if (text[end] === '}') depth -= 1;
        end += 1;
      } while (depth > 0 && end < text.length);
    }
    from = end;
  }
};

/**
 * A check that a revision only added macro{...} annotations (and the
 * lines of allowed, the annotation's definition): what it removed must be
 * what it added once the annotations are taken out of both, whitespace
 * aside, so a revision may also drop an annotation the document had. A
 * diff too long to be shown whole is not checked.
 */
export const addsOnly =
  (macro, allowed = '') =>
  (diffs) => {
    const definition = allowed.split('\n').filter((line) => line.trim() !== '');
    const squash = (text) => text.replace(/\s+/g, '');
    const changed = [];
    for (const { path, text, cut } of diffs) {
      if (text === null || cut) continue;
      let removed = '';
      let added = '';
      for (const line of text.split('\n')) {
        if (line.startsWith('-')) removed += line.slice(1);
        else if (line.startsWith('+') && !definition.includes(line.slice(1)))
          added += line.slice(1);
      }
      // Both sides without annotations: a line that already held one is
      // removed and added again when another joins it.
      if (squash(without(removed, macro)) !== squash(without(added, macro)))
        changed.push(path);
    }
    return changed.length === 0
      ? null
      : 'Your revision changed text outside ' +
          macro +
          '{...} annotations in ' +
          changed.join(', ') +
          '. Restore the original text exactly and keep only the annotations.';
  };

export const revise = async ({
  name,
  system = 'You revise LaTeX documents as instructed.\n\n' + LATEX,
  requests,
  review = CRITIC,
  reflect = false,
  verify,
  ...task
}) => {
  let critique = null;
  for (let revision = 0; revision < requests.length; revision += 1) {
    const label = 'Revision ' + (revision + 1);
    section(label);
    const context = await tools.document_context({
      ...task,
      requests,
      revision,
      critique,
    });
    const reply = await agent(context.prompt, {
      agentName: name,
      persona: { prompt: system },
      mediaFiles: context.mediaFiles,
      label,
    });
    await tools.document_extract({ revision, run: reply.runId });
    await tools.document_compile({ revision });
    await tools.document_diff({ revision });
    critique = null;
    if (revision + 1 === requests.length || !(verify || reflect)) continue;
    const evidence = await tools.document_review({ revision });
    const notes = [];
    const problem = verify ? verify(evidence.diffs) : null;
    if (problem) notes.push(problem);
    if (reflect) {
      const critic = await agent(evidence.prompt, {
        agentName: 'critic',
        persona: { prompt: review },
        label: 'Critique ' + (revision + 1),
      });
      notes.push(critic.response);
    }
    if (notes.length > 0) critique = notes.join('\n\n');
  }
  return tools.document_propose({});
};

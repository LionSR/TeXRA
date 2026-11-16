/**
 * The theory plugin's programs: the script modules a person or a model
 * starts by name to revise documents, and the module they share,
 * `builtIn:revise`. A program's run asks no model itself. It calls
 * `revise`, which runs one child agent per request (`agent()`), takes the
 * documents out of each reply, compiles and diffs them with the document
 * tools (`../documents/documentTools`), and ends by proposing the last
 * revision. What differs between programs is here: the child's system text,
 * the requests, a check of each revision, the templates a revision reads
 * and, in its registration, the outputs of a program that writes new
 * documents.
 *
 * A step records the module sources it ran, so a resumed run replays the
 * program it started with. `String.raw` keeps each module's own escapes as
 * written.
 */
import type { Program } from '@texra-ai/harness/plugins';
import {
  MERGE_EDITED_FILE,
  type DocumentsOutput,
} from '@texra/shared/plugins/documents';
import { DOCUMENT_TASK_RESULT } from '@texra/tools/documents/documentResult';

/** What every program's run is offered: the child agent and the document
 *  tools `revise` calls. */
const TOOLS = Object.freeze([
  'agent',
  'document_context',
  'document_extract',
  'document_compile',
  'document_diff',
  'document_review',
  'document_propose',
] as const);

/**
 * The module `builtIn:revise`.
 *
 * `revise(task)` runs `task.requests` in order, one revision each: every
 * revision is a fresh child told `task.system`, whose prompt is the
 * documents, the earlier requests with its replies, and this request. After
 * every revision but the last, `task.verify` (a function of the revision's
 * diffs, returning what is wrong or null) and, with `task.reflect`, a
 * critic told `task.review` may each add to what the next revision reads.
 * The rest of `task` goes to `document_context` as given.
 */
const REVISE_MODULE = String.raw`/** The \criticize annotation: its arguments, scale and definition. */
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
export const addsOnly = (macro, allowed = '') => (diffs) => {
  const definition = allowed.split('\n').filter((line) => line.trim() !== '');
  const squash = (text) => text.replace(/\s+/g, '');
  const changed = [];
  for (const { path, text, cut } of diffs) {
    if (text === null || cut) continue;
    let removed = '';
    let added = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('-')) removed += line.slice(1);
      else if (line.startsWith('+') && !definition.includes(line.slice(1))) added += line.slice(1);
    }
    // Both sides without annotations: a line that already held one is
    // removed and added again when another joins it.
    if (squash(without(removed, macro)) !== squash(without(added, macro))) changed.push(path);
  }
  return changed.length === 0
    ? null
    : 'Your revision changed text outside ' + macro + '{...} annotations in ' + changed.join(', ') + '. Restore the original text exactly and keep only the annotations.';
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
    const context = await tools.document_context({ ...task, requests, revision, critique });
    const reply = await agent(context.prompt, {
      agentName: name,
      persona: { prompt: system },
      mediaFiles: context.mediaFiles,
      memories: context.memories,
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
};`;

const EDIT_MODULE = String.raw`import { revise, LATEX } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'edit',
    system: 'You edit LaTeX research papers. Make only the changes the instruction asks for. With no instruction, proofread: correct typos, grammar and LaTeX formatting, and leave the claims, the mathematics and the authors\' style as they are.\n\n' + LATEX,
    intro: 'Read the following LaTeX research documents before editing them.',
    requests: [
      'Edit the documents as the instruction asks, to the extent it asks: a proofread changes wording and formatting only, a polish may rewrite sentences and paragraphs for clarity and flow, and a request for new or expanded content adds it with every derivation step shown. Do not change text the instruction does not concern. Write plain technical English: concrete statements, plain verbs, each point made once.',
      'Review your changes against the original and the instruction, then output the corrected documents. Revert any change the instruction did not ask for. Restore mathematics, equations or reasoning that went missing. Fix notation used before it is defined, and remove sentences that say nothing specific. If a change holds up, leave it alone; if nothing needs fixing, reproduce the documents unchanged.',
    ],
  });`;

const ANNOTATE_MODULE = String.raw`import { revise, addsOnly, ANNOTATIONS, CRITICIZE } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'annotate',
    system: 'You review research papers by adding \\criticize annotations to them. You never rewrite: outside your annotations, every document you return is the input, character for character.',
    intro: 'The following LaTeX documents need review. Read every document, appendices included, before you annotate.',
    requests: [
      'Review the documents from the point of view the instruction names; with none, as a careful referee of the mathematics. Work through each derivation and claim yourself before you judge it, and annotate every point that needs action: errors, gaps, unsupported or overstated claims, undefined terms, and inconsistencies between the documents. Rate each by its severity and your confidence. Return every document complete, with your annotations inserted and nothing else changed.\n\n' + ANNOTATIONS,
      'Check each annotation you added: verify the claim behind it again, correct its severity and confidence, remove the ones that do not hold, and add any you missed. Return every document complete, with the annotations inserted and nothing else changed.',
    ],
    // What a prompt can only ask for, checked: the diff adds annotations only.
    verify: addsOnly('\\criticize', CRITICIZE),
  });`;

const ENHANCE_MODULE = String.raw`import { revise, LATEX, ANNOTATIONS } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'enhance',
    system: 'You improve the substance of research papers: you make the improvements you can carry out in full, and leave a \\criticize annotation where an improvement needs the authors.\n\n' + LATEX,
    intro: 'The following LaTeX documents need improvement. Read the full collection, appendices included, before you change anything.',
    requests: [
      'Improve the documents in the respect the instruction names (for example the mathematical content, the logical structure of the argument, or the consistency of the notation); with none, look for simpler proofs, stronger results and gaps in the mathematics. Make each improvement you can carry out completely and correctly, showing every step of new mathematics. Where an improvement is larger than you can finish, or needs a decision from the authors, leave the text as it is and add an annotation that starts with "Suggestion:". Mark each change you made with an annotation that starts with "Implemented:".\n\n' + ANNOTATIONS,
      'Verify every change you made: rederive new mathematics step by step, check that each change is consistent with the rest of the documents, and revert any that does not hold. Then output the complete documents.',
    ],
  });`;

const APPLY_MODULE = String.raw`import { revise, LATEX } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'apply',
    system: 'You implement the fixes that inline annotations from an earlier review ask for (\\criticize{comment}{severity}{confidence}, \\todo{}, \\comment{} or % comments). The instruction decides which annotations to handle; with none, handle them all. Understand each issue, work through any mathematics it needs, and apply the fix; remove an annotation once it is handled or when its severity is 0.\n\n' + LATEX,
    intro: 'The following LaTeX documents contain inline annotations from an earlier review. Read every document and locate every annotation.',
    requests: [
      'Apply the annotations: correct errors directly, write out missing steps and derivations in full, rewrite unclear passages in plain technical English, and resolve inconsistencies between the documents to one version. Do not use notation before the document defines it. Leave an annotation in place, unchanged, when the instruction excludes it or you cannot resolve it. Output the complete documents.',
    ],
  });`;

const MERGE_MODULE = String.raw`import { revise } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'merge',
    system: 'You merge the changes of an edited LaTeX document into its original. You keep the original\'s structure and formatting and incorporate every edit.',
    intro: 'Create one complete LaTeX document from the original document and its edited version below. Keep the original\'s structure, so that a diff of the two versions shows only the edits.',
    requests: [
      'Where the edited version says a part is unchanged or leaves it out, copy that part from the original verbatim. Where it shows an edit or an addition, incorporate it exactly as written, in place of the corresponding part of the original. Keep every section header, equation, figure, table, macro and comment in its place; where the edited version is ambiguous, keep the original. Before you answer, check that every edit is in and nothing else changed. Output the complete merged document.',
    ],
  });`;

const TRANSCRIBE_MODULE = String.raw`import { revise } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'transcribe',
    system: 'You turn attached media into LaTeX. Images of handwriting or scans are pages of one text, in the order given: you write their content in the notation and style of the context documents. Recordings are one session, in the order given: you transcribe the spoken words with speakers and timestamps, a short opening summary and logical sections, and write spoken mathematics as LaTeX equations.',
    intro: 'Transcribe the attached media into one LaTeX document that compiles on its own. Any documents below are context for its notation and style.',
    requests: [
      'Write the document. For images, use the document class, notation, environments and symbols of the context documents when there are any. For a recording, open with a short summary of the topics, then write each utterance as "[HH:MM:SS] Speaker: text", grouped into sections; do not use markdown.',
      'Review your transcription against the media and output the final document. For images, fix symbols you misread or that differ from the context documents\' notation, subscripts and superscripts, and environments. For a recording, fix misheard words, speaker labels, timestamps and equations.',
    ],
  });`;

const SLIDES_MODULE = String.raw`import { revise } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'slides',
    templates: ['template_slide.tex'],
    system: 'You turn research papers into LaTeX Beamer presentations for a scientific audience. Each slide makes one point; every bullet states a specific fact, method or result in plain words.',
    intro: 'Create a LaTeX Beamer presentation from the research paper below. Use the template among the documents as its skeleton.',
    requests: [
      'Write a complete, self-contained deck of 10 to 15 slides: introduction, the paper\'s methods and key results with their equations, and a conclusion slide. Follow the instruction when there is one.',
      'Review the draft deck for the accuracy of the paper\'s claims, slide organization, equation formatting and plain, concrete phrasing. Fix what you find and output the complete deck; if nothing needs fixing, reproduce it unchanged.',
    ],
  });`;

const POSTER_MODULE = String.raw`import { revise } from 'builtIn:revise';

export default (args) =>
  revise({
    ...args,
    name: 'poster',
    templates: ['template_poster.tex', 'beamercolorthemempi.sty', 'beamerthemeconfposter.sty'],
    system: 'You turn research papers into mathematically detailed LaTeX Beamer posters for a scientific audience, written plainly and concretely.',
    intro: 'Create a LaTeX Beamer poster from the research paper below. Use the poster template among the documents as its skeleton, with the template\'s theme and color scheme.',
    requests: [
      'Write a complete, self-contained poster with clear sections (abstract, introduction, framework, methods, results, discussion, conclusions), the paper\'s key equations and derivations, and compact references. Follow the instruction when there is one.',
      'Review the draft poster for mathematical accuracy, readability at poster size, compact references, use of the template\'s color scheme and plain, concrete phrasing. Fix what you find and output the complete poster; if nothing needs fixing, reproduce it unchanged.',
    ],
  });`;

/** A program's registration: its `description`, with the tools and result
 *  reading every theory program shares. */
const program = (
  description: string,
  outputs?: readonly string[],
): Program<DocumentsOutput> =>
  Object.freeze({
    description,
    tools: TOOLS,
    result: DOCUMENT_TASK_RESULT,
    ...(outputs !== undefined && { outputs: Object.freeze(outputs) }),
  });

/** The theory plugin's script modules, by name. */
export const THEORY_MODULES = Object.freeze({
  revise: REVISE_MODULE,
  edit: EDIT_MODULE,
  annotate: ANNOTATE_MODULE,
  enhance: ENHANCE_MODULE,
  apply: APPLY_MODULE,
  merge: MERGE_MODULE,
  transcribe: TRANSCRIBE_MODULE,
  slides: SLIDES_MODULE,
  poster: POSTER_MODULE,
});

/**
 * The modules that are programs, each over `inputFiles` with an optional
 * instruction. A point of view (the argument's logic, the notation, a first
 * reader) is a sentence of the instruction, not a program.
 */
export const THEORY_PROGRAMS = Object.freeze({
  edit: program(
    'Rewrite the documents as the instruction asks, from a proofread to new content; with no instruction, proofread.',
  ),
  annotate: program(
    'Review the documents by adding `\\criticize{}` annotations; never rewrites. The instruction names the point of view.',
  ),
  enhance: program(
    'Improve the substance (mathematics, logic or notation, as the instruction names): makes the changes it can, annotates the rest.',
  ),
  apply: program(
    'Implement the fixes that inline annotations from an earlier review ask for.',
  ),
  merge: Object.freeze({
    ...program(
      'Merge a partial edit (`args.editedFile`) back into the full original document, its one input. Started by the Merge action, which supplies the edited file.',
    ),
    fileArgs: Object.freeze([MERGE_EDITED_FILE]),
  }),
  transcribe: program(
    'Turn `mediaFiles` (handwriting or scans, or audio) into a LaTeX document.',
    ['transcript.tex'],
  ),
  slides: program(
    'Turn a paper into a Beamer slide deck on the bundled template.',
    ['slides.tex'],
  ),
  poster: program(
    'Turn a paper into a Beamer poster on the bundled template.',
    ['poster.tex'],
  ),
} satisfies Record<string, Program<DocumentsOutput>>);

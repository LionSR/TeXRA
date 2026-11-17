/**
 * The lean4 plugin's programs: `prove` completes the proofs in Lean files
 * and `blueprint` writes or brings up to date a LeanBlueprint document. Each
 * runs one child agent per round, told the program's system text and given
 * the file, shell and Lean tools, and checks the round's work in code before
 * it ends or starts the next: `prove` with Lean's own diagnostics (no error,
 * no `sorry`), `blueprint` with `lean_blueprint`'s check of the dependency
 * graph. The checks are what make them programs and not a sentence of a
 * prompt.
 *
 * A step records the module sources it ran, so a resumed run replays the
 * program it started with. `String.raw` keeps each module's own escapes as
 * written.
 */
import type { Program } from '@texra-ai/harness/plugins';

/** The module `builtIn:prove`. */
const PROVE_MODULE = String.raw`const PROVER = [
  'You complete formal proofs in a Lean 4 project. Work out the mathematics first: understand each statement, find the argument, and write a short informal outline before you write tactics.',
  'Find what the library already has before you prove it yourself: lean_loogle searches Mathlib by type signature or name pattern (it takes several queries at once), and when the project has a .lake/packages directory, grep and glob read Mathlib and the other dependencies directly.',
  'Write a proof, then check the file with lean_diagnostics, and repeat until Lean reports no error and no declaration that uses sorry. lean_inspect shows the goal at a position; lean_file makes Lean read a file again after you change its imports. Do not leave sorry, admit or a new axiom in place of a proof.',
  'Keep every statement as it is: change a theorem\'s hypotheses or conclusion only when the instruction asks, and say so in your answer when a statement is false as written. Keep the project\'s names and conventions, and when its AGENTS.md lists tactics or automation, use them.',
  'Read a file before you edit it. Your answer goes to the person who started the program: say what you proved and how, in a few sentences with the mathematics in $...$, and name anything you could not finish.',
].join('\n\n');

/** The child's tools: files, shell and Lean. */
const TOOLS = ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash', 'lean_diagnostics', 'lean_inspect', 'lean_file', 'lean_project', 'lean_loogle'];

const ROUNDS = 3;

/** Lean's verdict on file, asked again while Lean is still elaborating. */
const diagnose = async (file) => {
  for (let poll = 1; ; poll += 1) {
    const result = await tools.lean_diagnostics({ file });
    if (result.complete || poll === 5) return result;
  }
};

/** What Lean still reports in files, or null when every one is clean. */
const unfinished = async (files) => {
  const verdicts = await Promise.all(files.map(async (file) => ({ file, result: await diagnose(file) })));
  const open = verdicts.filter(({ result }) => !result.complete || result.errors > 0 || result.sorries > 0);
  if (open.length === 0) return null;
  return open
    .map(({ file, result }) => '<diagnostics file="' + file + '" summary="' + result.summary + '">\n' + result.output + '\n</diagnostics>')
    .join('\n');
};

export default async (args, { instruction, inputFiles, contextFiles }) => {
  const files = inputFiles.filter((file) => file.endsWith('.lean'));
  if (files.length === 0) throw new Error('prove works on Lean files: pass the .lean files to complete as inputFiles.');
  const task = [
    instruction.trim()
      ? '<instruction>\n' + instruction.trim() + '\n</instruction>'
      : 'Complete every proof in these files: replace each sorry with a proof and fix every error.',
    'The files to complete: ' + files.join(', ') + '.',
    ...(contextFiles.length > 0 ? ['Read these for context and do not change them: ' + contextFiles.join(', ') + '.'] : []),
  ].join('\n\n');
  let report = null;
  let reply = null;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const label = 'Round ' + round;
    section(label);
    const prompt = report === null ? task : task + '\n\nAn earlier round left these files unfinished. Lean reports:\n' + report;
    reply = await agent(prompt, { agentName: 'prove', persona: { prompt: PROVER, tools: TOOLS }, label, id: 'round-' + round });
    report = await unfinished(files);
    if (report === null) return 'Lean reports no error and no sorry in ' + files.join(', ') + '.\n\n' + reply.response;
  }
  return 'After ' + ROUNDS + ' rounds Lean still reports:\n' + report + '\n\n' + reply.response;
};`;

/** The module `builtIn:blueprint`. */
const BLUEPRINT_MODULE = String.raw`const WRITER = [
  'You write and maintain formalization blueprints: LaTeX documents, built with the leanblueprint package and its CLI, that split a proof into small statements with explicit dependencies and link each to its Lean declaration. Follow the package\'s own macros and the file layout leanblueprint new creates; invent no parallel conventions.',
  'The macros. Inside a definition, lemma, proposition, theorem or corollary, each with a \\label: \\lean{Name.decl} links Lean declarations (comma-separated), \\leanok marks the statement formalized, \\mathlibok marks it in Mathlib, \\uses{label, ...} lists the statements it depends on, and \\notready marks one that needs more blueprint work. Inside a proof: \\uses{...} for what the proof relies on, \\leanok when the proof is formalized, and \\proves{label} for a proof separated from its statement.',
  'Write the mathematics as a paper does, in standard notation: no Lean syntax, identifiers or type signatures in the prose. A Lean predicate becomes a sentence, a typeclass assumption becomes "let G be a group", a type becomes the set it stands for. \\lean{} is the only place a Lean name appears. Refer to statements by \\ref to their labels, never by number. Each statement states its hypotheses in full; a proof sketch gives the strategy in a sentence or two, enough for a formalizer to follow.',
  'To write a new blueprint, survey the Lean project first, then design the dependency graph backward from the main results: each node one well-defined fact. To bring an existing one up to date, check every \\lean name against the source (renamed or removed declarations), every \\leanok against lean_diagnostics (no error, no sorry), every statement against its declaration\'s type (lean_inspect hover), and every \\uses against what the proof actually relies on; add entries for significant declarations the blueprint lacks. Where leanblueprint is installed, run leanblueprint checkdecls.',
  'Your answer goes to the person who started the program: what you wrote or changed, what is out of sync or mathematically suspect, and what you left for them.',
].join('\n\n');

/** The child's tools: files, shell, Lean and the literature. */
const TOOLS = ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash', 'lean_diagnostics', 'lean_inspect', 'lean_loogle', 'lean_blueprint', 'web_search', 'web_fetch', 'arxiv_search'];

const ROUNDS = 2;

export default async (args, { instruction, inputFiles, contextFiles }) => {
  const files = inputFiles.filter((file) => file.endsWith('.tex'));
  if (files.length === 0)
    throw new Error('blueprint works on a blueprint\'s .tex files: pass them as inputFiles. A project without one starts with leanblueprint new.');
  const task = [
    instruction.trim()
      ? '<instruction>\n' + instruction.trim() + '\n</instruction>'
      : 'Bring this blueprint up to date with the Lean project.',
    'The blueprint\'s files: ' + files.join(', ') + '.',
    ...(contextFiles.length > 0 ? ['Read these for context and do not change them: ' + contextFiles.join(', ') + '.'] : []),
  ].join('\n\n');
  let check = null;
  let reply = null;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const label = 'Round ' + round;
    section(label);
    const prompt = check === null ? task : task + '\n\nThe blueprint\'s dependency graph has problems to fix:\n' + check.output;
    reply = await agent(prompt, { agentName: 'blueprint', persona: { prompt: WRITER, tools: TOOLS }, label, id: 'round-' + round });
    check = await tools.lean_blueprint({ files });
    if (check.problems.length === 0) return check.output + '\n\n' + reply.response;
  }
  return 'The dependency graph still has problems: ' + check.output + '\n\n' + reply.response;
};`;

/** The lean4 plugin's script modules, by name. */
export const LEAN_MODULES = Object.freeze({
  prove: PROVE_MODULE,
  blueprint: BLUEPRINT_MODULE,
});

/** Both modules are programs, each over `inputFiles` with an optional
 *  instruction; each answers with its last round's reply and its check. */
export const LEAN_PROGRAMS = Object.freeze({
  prove: Object.freeze({
    description:
      'Complete the proofs in the `.lean` files of `inputFiles` until Lean reports no error and no `sorry`; the instruction narrows which.',
    tools: Object.freeze(['agent', 'lean_diagnostics']),
  }),
  blueprint: Object.freeze({
    description:
      'Write or bring up to date a LeanBlueprint document (its `.tex` files are `inputFiles`) until its dependency graph checks clean.',
    tools: Object.freeze(['agent', 'lean_blueprint']),
  }),
} satisfies Record<string, Program>);

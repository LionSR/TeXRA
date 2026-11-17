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

/**
 * The module `builtIn:rounds`, which both programs are built on.
 *
 * `rounds(task, launch)` runs a fresh child per round, told `task.system`
 * and given `task.tools`, over the files of `launch.inputFiles` that end in
 * `task.extension`. After each round `task.check(files)` answers
 * `{ clean, report }`: the round ends the program when `clean`, and
 * otherwise the next round reads the report. It answers with the last
 * report and the child's last reply.
 */
const ROUNDS_MODULE = String.raw`export const rounds = async (
  { name, system, tools, rounds, extension, describes, fallback, check },
  { instruction, inputFiles, contextFiles },
) => {
  const files = inputFiles.filter((file) => file.endsWith(extension));
  const skipped = inputFiles.filter((file) => !file.endsWith(extension));
  if (files.length === 0)
    throw new Error(name + ' works on ' + extension + ' files: pass ' + describes + ' as inputFiles.');
  const task = [
    instruction.trim() ? '<instruction>\n' + instruction.trim() + '\n</instruction>' : fallback,
    'The files: ' + files.join(', ') + '.',
    ...(contextFiles.length > 0 ? ['Read these for context and do not change them: ' + contextFiles.join(', ') + '.'] : []),
  ].join('\n\n');
  // A file the program does not work on is named, never dropped unsaid.
  const answer = (verdict, reply) =>
    [verdict, ...(skipped.length > 0 ? ['Not ' + extension + ' files, so not worked on: ' + skipped.join(', ') + '.'] : []), reply].join('\n\n');
  let checked = null;
  let reply = null;
  for (let round = 1; round <= rounds; round += 1) {
    const label = 'Round ' + round;
    section(label);
    const prompt = checked === null ? task : task + '\n\nAn earlier round left work to do. The check reports:\n' + checked.report;
    reply = await agent(prompt, { agentName: name, persona: { prompt: system, tools }, label, id: 'round-' + round });
    checked = await check(files);
    if (checked.clean) return answer(checked.report, reply.response);
  }
  return answer('After ' + rounds + ' rounds the check still reports:\n' + checked.report, reply.response);
};`;

/** The module `builtIn:prove`. */
const PROVE_MODULE = String.raw`import { rounds } from 'builtIn:rounds';

const PROVER = [
  'You complete formal proofs in a Lean 4 project. Work out the mathematics first: understand each statement, find the argument, and write a short informal outline before you write tactics.',
  'Find what the library already has before you prove it yourself: lean_loogle searches Mathlib by type signature or name pattern (it takes several queries at once), and when the project has a .lake/packages directory, grep and glob read Mathlib and the other dependencies directly.',
  'Write a proof, then check the file, and repeat until Lean reports no error and no declaration that uses sorry. Lean reads a file only when it opens it, so after every edit call lean_file on the file before lean_diagnostics; otherwise the diagnostics describe the file as it was. lean_inspect shows the goal at a position. Do not leave sorry, admit or a new axiom in place of a proof.',
  'Keep every statement as it is: change a theorem\'s hypotheses or conclusion only when the instruction asks, and say so in your answer when a statement is false as written. Keep the project\'s names and conventions, and when its AGENTS.md lists tactics or automation, use them.',
  'Read a file before you edit it. Your answer goes to the person who started the program: say what you proved and how, in a few sentences with the mathematics in $...$, and name anything you could not finish.',
].join('\n\n');

/** Lean's verdict on file as it is on disk now: reopened, so Lean reads
 *  the child's edits, then asked again while Lean is still elaborating. */
const diagnose = async (file) => {
  await tools.lean_file({ file });
  for (let poll = 1; ; poll += 1) {
    const result = await tools.lean_diagnostics({ file });
    if (result.complete || poll === 5) return result;
  }
};

/** Whether Lean reports every file clean, and what it still reports. */
const check = async (files) => {
  const verdicts = [];
  for (const file of files) verdicts.push({ file, result: await diagnose(file) });
  const open = verdicts.filter(({ result }) => !result.complete || result.errors > 0 || result.sorries > 0);
  if (open.length === 0) return { clean: true, report: 'Lean reports no error and no sorry in ' + files.join(', ') + '.' };
  return {
    clean: false,
    report: open
      .map(({ file, result }) => '<diagnostics file="' + file + '" summary="' + result.summary + '">\n' + result.output + '\n</diagnostics>')
      .join('\n'),
  };
};

export default (args, launch) =>
  rounds(
    {
      name: 'prove',
      system: PROVER,
      tools: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash', 'lean_diagnostics', 'lean_inspect', 'lean_file', 'lean_project', 'lean_loogle'],
      rounds: 3,
      extension: '.lean',
      describes: 'the .lean files to complete',
      fallback: 'Complete every proof in these files: replace each sorry with a proof and fix every error.',
      check,
    },
    launch,
  );`;

/** The module `builtIn:blueprint`. */
const BLUEPRINT_MODULE = String.raw`import { rounds } from 'builtIn:rounds';

const WRITER = [
  'You write and maintain formalization blueprints: LaTeX documents, built with the leanblueprint package and its CLI, that split a proof into small statements with explicit dependencies and link each to its Lean declaration. Follow the package\'s own macros and the file layout leanblueprint new creates; invent no parallel conventions.',
  'The macros. Inside a definition, lemma, proposition, theorem or corollary, each with a \\label: \\lean{Name.decl} links Lean declarations (comma-separated), \\leanok marks the statement formalized, \\mathlibok marks it in Mathlib, \\uses{label, ...} lists the statements it depends on, and \\notready marks one that needs more blueprint work. Inside a proof: \\uses{...} for what the proof relies on, \\leanok when the proof is formalized, and \\proves{label} for a proof separated from its statement.',
  'Write the mathematics as a paper does, in standard notation: no Lean syntax, identifiers or type signatures in the prose. A Lean predicate becomes a sentence, a typeclass assumption becomes "let G be a group", a type becomes the set it stands for. \\lean{} is the only place a Lean name appears. Refer to statements by \\ref to their labels, never by number. Each statement states its hypotheses in full; a proof sketch gives the strategy in a sentence or two, enough for a formalizer to follow.',
  'To write a new blueprint, survey the Lean project first, then design the dependency graph backward from the main results: each node one well-defined fact. To bring an existing one up to date, check every \\lean name against the source (renamed or removed declarations), every \\leanok against lean_diagnostics (no error, no sorry; call lean_file on a Lean file first, since Lean reads a file only when it opens it), every statement against its declaration\'s type (lean_inspect hover), and every \\uses against what the proof actually relies on; add entries for significant declarations the blueprint lacks. Where leanblueprint is installed, run leanblueprint checkdecls.',
  'Your answer goes to the person who started the program: what you wrote or changed, what is out of sync or mathematically suspect, and what you left for them.',
].join('\n\n');

export default (args, launch) =>
  rounds(
    {
      name: 'blueprint',
      system: WRITER,
      tools: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash', 'lean_diagnostics', 'lean_inspect', 'lean_file', 'lean_loogle', 'lean_blueprint', 'web_search', 'web_fetch', 'arxiv_search'],
      rounds: 2,
      extension: '.tex',
      describes: "the blueprint's .tex files (a project without one starts with leanblueprint new)",
      fallback: 'Bring this blueprint up to date with the Lean project.',
      check: async (files) => {
        const { problems, output } = await tools.lean_blueprint({ files });
        return { clean: problems.length === 0, report: output };
      },
    },
    launch,
  );`;

/** The lean4 plugin's script modules, by name. */
export const LEAN_MODULES = Object.freeze({
  rounds: ROUNDS_MODULE,
  prove: PROVE_MODULE,
  blueprint: BLUEPRINT_MODULE,
});

/** The modules that are programs, each over `inputFiles` with an optional
 *  instruction; each answers with its check's verdict and its last round's
 *  reply. */
export const LEAN_PROGRAMS = Object.freeze({
  prove: Object.freeze({
    description:
      'Complete the proofs in the `.lean` files of `inputFiles` until Lean reports no error and no `sorry`; the instruction narrows which.',
    tools: Object.freeze(['agent', 'lean_file', 'lean_diagnostics']),
  }),
  blueprint: Object.freeze({
    description:
      'Write or bring up to date a LeanBlueprint document (its `.tex` files are `inputFiles`) until its dependency graph checks clean.',
    tools: Object.freeze(['agent', 'lean_blueprint']),
  }),
} satisfies Record<string, Program>);

/**
 * `lean_blueprint`: check the dependency graph of a LeanBlueprint document,
 * the LaTeX that maps a formalization's statements to its Lean declarations.
 * What it checks is what text alone decides: every collected statement has
 * a `\label`, labels are unique, every `\uses` and `\proves` names a label,
 * no statement depends on itself, and every `\leanok` statement names its
 * declaration with `\lean`. Whether the named declarations exist is
 * `leanblueprint checkdecls`'s question, not this one.
 */

// Third-party imports
import { Effect, FileSystem, Schema } from 'effect';

// Local imports
import {
  ToolContext,
  ToolError,
  defineTool,
  executed,
  resolveToolPath,
} from '@texra-ai/harness/plugins';
import { formatResultCount } from '@texra-ai/harness/schemas';

/** The environments `leanblueprint` collects into the graph by default. */
const STATEMENTS = new Set([
  'definition',
  'lemma',
  'proposition',
  'theorem',
  'corollary',
]);

/** A label one macro names, and where. */
interface Reference {
  readonly label: string;
  readonly at: string;
}

/** One collected statement; its proof's `\uses` are added to it. */
interface Item {
  readonly env: string;
  readonly at: string;
  label: string | null;
  readonly uses: Reference[];
  readonly lean: string[];
  leanok: boolean;
}

/** One proof: the statement it follows, the one its `\proves` names when
 *  it is separated from it, and its `\uses`. */
interface Proof {
  readonly after: Item | null;
  proves: Reference | null;
  readonly uses: Reference[];
}

/** The macros the check reads, and the environment bounds around them;
 *  TeX allows whitespace between a command and its argument. */
const TOKEN =
  /\\begin\s*\{(\w+)\}|\\end\s*\{(\w+)\}|\\(label|uses|proves|lean)\s*\{([^}]*)\}|\\leanok\b/g;

/** `text` without its comments: from an unescaped `%` to the line's end. */
const withoutComments = (text: string): string =>
  text.replaceAll(/(?<!\\)%.*$/gm, '');

/** The statements and proofs of one file, in order. */
function readFile(
  file: string,
  text: string,
): { readonly items: Item[]; readonly proofs: Proof[] } {
  const source = withoutComments(text);
  const lineAt = (index: number) =>
    `${file}:${source.slice(0, index).split('\n').length}`;
  const items: Item[] = [];
  const proofs: Proof[] = [];
  let statement: Item | null = null;
  let proof: Proof | null = null;
  for (const match of source.matchAll(TOKEN)) {
    const [, begin, end, macro, argument = ''] = match;
    const at = lineAt(match.index);
    if (begin !== undefined) {
      if (STATEMENTS.has(begin)) {
        statement = {
          env: begin,
          at,
          label: null,
          uses: [],
          lean: [],
          leanok: false,
        };
        items.push(statement);
      } else if (begin === 'proof') {
        proof = { after: items.at(-1) ?? null, proves: null, uses: [] };
        proofs.push(proof);
      }
      continue;
    }
    if (end !== undefined) {
      if (STATEMENTS.has(end)) statement = null;
      else if (end === 'proof') proof = null;
      continue;
    }
    const names = argument
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    // A proof's \leanok says the proof is formalized, not the statement.
    if (macro === undefined) {
      if (statement !== null) statement.leanok = true;
    } else if (macro === 'label') {
      if (statement !== null && statement.label === null)
        statement.label = names[0] ?? null;
    } else if (macro === 'uses') {
      (statement ?? proof)?.uses.push(...names.map((label) => ({ label, at })));
    } else if (macro === 'lean') {
      statement?.lean.push(...names);
    } else if (proof !== null && names[0] !== undefined) {
      proof.proves = { label: names[0], at };
    }
  }
  return { items, proofs };
}

/** Every file's statements, each with its proof's `\uses` (a separated
 *  proof's go to the statement its `\proves` names, in any file), and the
 *  `\proves` references to check. */
function readBlueprint(files: readonly { display: string; text: string }[]): {
  readonly items: readonly Item[];
  readonly proves: readonly Reference[];
} {
  const read = files.map(({ display, text }) => readFile(display, text));
  const items = read.flatMap(({ items }) => items);
  const proofs = read.flatMap(({ proofs }) => proofs);
  for (const { after, proves, uses } of proofs) {
    const proved =
      proves === null
        ? after
        : items.find(({ label }) => label === proves.label);
    proved?.uses.push(...uses);
  }
  return {
    items,
    proves: proofs.flatMap(({ proves }) => (proves === null ? [] : [proves])),
  };
}

/** What is wrong with the graph of `items`, one line each. */
function graphProblems(
  items: readonly Item[],
  proves: readonly Reference[],
): string[] {
  const problems: string[] = [];
  const byLabel = new Map<string, Item>();
  for (const item of items) {
    if (item.label === null) {
      problems.push(
        `${item.at}: this ${item.env} has no \\label, so nothing can depend on it.`,
      );
      continue;
    }
    const earlier = byLabel.get(item.label);
    if (earlier !== undefined)
      problems.push(
        `${item.at}: the label "${item.label}" is already used at ${earlier.at}.`,
      );
    else byLabel.set(item.label, item);
  }
  for (const { label, at } of [...items.flatMap(({ uses }) => uses), ...proves])
    if (!byLabel.has(label))
      problems.push(`${at}: "${label}" is not the label of any statement.`);
  for (const item of items)
    if (item.leanok && item.lean.length === 0)
      problems.push(
        `${item.at}: this ${item.env} is marked \\leanok but names no declaration with \\lean.`,
      );
  // Depth-first over the labelled items; a back edge closes a cycle.
  const state = new Map<Item, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (item: Item): string[] | null => {
    state.set(item, 'open');
    path.push(item.label ?? item.at);
    for (const { label } of item.uses) {
      const next = byLabel.get(label);
      if (next === undefined || state.get(next) === 'done') continue;
      if (state.get(next) === 'open')
        return [...path.slice(path.indexOf(label)), label];
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    path.pop();
    state.set(item, 'done');
    return null;
  };
  for (const item of byLabel.values()) {
    if (state.has(item)) continue;
    const cycle = visit(item);
    if (cycle !== null) {
      problems.push(
        `The statements depend on each other in a cycle: ${cycle.join(' → ')}.`,
      );
      break;
    }
  }
  return problems;
}

const LeanBlueprintInputSchema = Schema.Struct({
  files: Schema.Array(Schema.String).check(Schema.isMinLength(1)).annotate({
    description:
      "The blueprint's .tex files (as `leanblueprint new` lays them out, its content files under blueprint/src/).",
  }),
});
type LeanBlueprintInput = typeof LeanBlueprintInputSchema.Type;

export const LeanBlueprintTool = defineTool({
  name: 'lean_blueprint',
  replay: 'safe',
  scriptReturns:
    '{ output: string; items: number; formalized: number; problems: string[] }',
  description: `Check the dependency graph of a LeanBlueprint document over its .tex files: every definition, lemma, proposition, theorem and corollary has a \\label and the labels are unique, every \\uses and \\proves names one of them, no statement depends on itself through others, and every \\leanok statement names its Lean declaration with \\lean.

It reads the text only: whether each \\lean name is a real declaration is \`leanblueprint checkdecls\`'s check, and whether it compiles is lean_diagnostics'.`,
  schema: LeanBlueprintInputSchema,
  execute: Effect.fn('LeanBlueprintTool.execute')(function* ({
    files,
  }: LeanBlueprintInput) {
    const call = yield* ToolContext;
    const fs = yield* FileSystem.FileSystem;
    const read = yield* Effect.forEach(files, (file) =>
      Effect.gen(function* () {
        const { absolute, display } = yield* resolveToolPath(call.env, file);
        const text = yield* fs.readFileString(absolute);
        return { display, text };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ToolError(`Could not read ${file}: ${cause.message}`, {
              cause,
              summary: 'Could not read the blueprint',
            }),
        ),
      ),
    );
    const { items, proves } = readBlueprint(read);
    const problems = graphProblems(items, proves);
    const formalized = items.filter(({ leanok }) => leanok).length;
    const counted = `${formatResultCount(items.length, 'statement')}, ${formalized} marked \\leanok`;
    const output =
      problems.length === 0
        ? `${counted}; the dependency graph is consistent.`
        : `${counted}. ${formatResultCount(problems.length, 'problem')}:\n${problems.map((line) => `- ${line}`).join('\n')}`;
    return {
      ...executed(
        output,
        problems.length === 0
          ? `✓ ${counted}`
          : formatResultCount(problems.length, 'problem'),
      ),
      value: { output, items: items.length, formalized, problems },
    };
  }),
});

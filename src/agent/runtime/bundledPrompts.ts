/**
 * One loader for every prompt template that ships inside a host's packaged
 * `resources/` bundle.
 *
 * Each host calls `initializeBundledPrompts(resourcesPath)` exactly once at
 * startup with its own resolved resources root, and every row of
 * {@link BUNDLED_PROMPTS} is reachable. There is deliberately no per-prompt
 * initializer: two of them existed (polish and goal), each host had to
 * remember both, and desktop shipped a release that remembered goal and forgot
 * polish — so every desktop follow-up polish failed with "Polish model not
 * initialized" (#10365). A new prompt is a table row, not a fourth thing three
 * composition roots must remember.
 *
 * Availability is per-row data, not a branch at the call site: `required` rows
 * reject when the bundle is missing or malformed; `fallback` rows return their
 * inline copy instead, warning whenever a bundle that *should* have loaded
 * could not be read or parsed. So the CLI — whose bundle ships `goal/` but not
 * `templates/instructionPolish.yaml` (`copy-resources.mjs`), and which renders
 * no polish prompt — registers both rows for free, since rows are read lazily
 * and a CLI polish caller would fail loudly rather than silently.
 */

// Node imports
import { join } from 'node:path';

// Third-party imports
import { z } from 'zod';

// Local imports
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import * as logger from '@logger/logUtils';
import { createTexraNunjucksEnvironment } from '@utils/prompt';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';

const GoalPromptsSchema = z.object({
  continuation: z.object({ template: z.string().min(1) }),
});

type GoalPrompts = z.infer<typeof GoalPromptsSchema>;

// Trailing newline matches the YAML `|` (clip) chomping in goal.yaml so
// the rendered prompt is byte-identical across host-loaded and inline paths.
// Keep this in sync with packages/extension/resources/goal/goal.yaml —
// the YAML is the source of truth; this copy is used when no host has wired
// the bundle (tests) or when the bundled file cannot be read, and the parity
// test pins it line-for-line against the YAML so it is a substitution rather
// than a degradation.
const INLINE_GOAL_PROMPTS: GoalPrompts = {
  continuation: {
    template:
      [
        '<goal_context>',
        'Autonomous objective active. Keep working until it is verifiably done.',
        'Do not end your turn to summarize progress or hand back control; only',
        "stop when the objective's end state is true and you have inspected real",
        'evidence for it. Persist even when a tool call or command fails:',
        'diagnose, adjust, and retry rather than yielding.',
        '',
        '<objective>',
        '{{objective}}',
        '</objective>',
        '',
        'Time elapsed: {{timeUsed}}',
        '',
        '- Do not redefine success around a smaller or easier task, and do not',
        '  substitute a narrower, safer, or merely test-passing solution for the',
        '  behavior the objective requests.',
        '- If you cannot finish this turn, make concrete progress and keep going.',
        '- Treat completion as unproven until you have inspected authoritative',
        '  evidence (file contents, command output, test results, runtime',
        "  behavior) for every requirement. Match the check's scope to the",
        "  requirement's scope, and gather stronger evidence when it is weak or",
        '  indirect.',
        '</goal_context>',
      ].join('\n') + '\n',
  },
};

/** What a row does when its bundled file is absent or unreadable. */
type PromptAvailability<T> =
  | { readonly kind: 'required' }
  | { readonly kind: 'fallback'; readonly inline: T };

interface BundledPrompt<T> {
  /** Path segments under the host's packaged `resources/` root. */
  readonly relPath: readonly string[];
  readonly schema: z.ZodType<T>;
  readonly whenUnavailable: PromptAvailability<T>;
}

/** Identity helper: infers each row's `T` from its schema inside the table. */
function bundledPrompt<T>(row: BundledPrompt<T>): BundledPrompt<T> {
  return row;
}

const BUNDLED_PROMPTS = {
  polish: bundledPrompt({
    relPath: ['templates', 'instructionPolish.yaml'],
    schema: z.object({ prompts: z.object({ userRequest: z.string() }) }),
    whenUnavailable: { kind: 'required' },
  }),
  goal: bundledPrompt({
    relPath: ['goal', 'goal.yaml'],
    schema: GoalPromptsSchema,
    whenUnavailable: { kind: 'fallback', inline: INLINE_GOAL_PROMPTS },
  }),
};

type PromptName = keyof typeof BUNDLED_PROMPTS;

type PromptValue<N extends PromptName> =
  (typeof BUNDLED_PROMPTS)[N] extends BundledPrompt<infer T> ? T : never;

let resourcesRoot: string | null = null;
const loaded = new Map<PromptName, Promise<unknown>>();

/**
 * Point every bundled prompt at the host's packaged `resources/` root.
 *
 * Safe to call repeatedly: a later call replaces the root and drops the cache,
 * so CLI validation can re-enter platform init with a different resources path
 * in the same process.
 */
export function initializeBundledPrompts(resourcesPath: string): void {
  resourcesRoot = resourcesPath;
  loaded.clear();
}

async function readBundledPrompt<T>(
  name: PromptName,
  row: BundledPrompt<T>,
): Promise<T> {
  const root = resourcesRoot;
  if (root === null) {
    if (row.whenUnavailable.kind === 'fallback')
      return row.whenUnavailable.inline;
    throw new Error(
      `Bundled prompt "${name}" is unavailable: no host called initializeBundledPrompts().`,
    );
  }

  const filePath = join(root, ...row.relPath);
  try {
    const content = await AbsoluteFS.read(filePath);
    const parsed = parseYamlWith(content, row.schema);
    if (parsed.isErr()) {
      throw new Error(
        `Failed to parse ${name} prompt YAML at ${filePath}: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    }
    return parsed.value;
  } catch (error) {
    if (row.whenUnavailable.kind === 'required') throw error;
    // Warn so a broken or missing bundled file is detectable rather than
    // silently masked by the inline copy.
    logger.warn(
      'BundledPrompts',
      `Failed to load bundled ${name} prompts from ${filePath}; using inline templates: ${toErrorMessage(error)}`,
    );
    return row.whenUnavailable.inline;
  }
}

function loadBundledPrompt<N extends PromptName>(
  name: N,
): Promise<PromptValue<N>> {
  // The two casts in this module. The table is heterogeneous, so indexing it
  // with a generic key yields the union of its rows and the cache cannot carry
  // a per-key promise type. `PromptValue<N>` is derived from that same table,
  // so the narrowing cannot drift from the row actually read.
  const cached = loaded.get(name) as Promise<PromptValue<N>> | undefined;
  if (cached) return cached;
  const row = BUNDLED_PROMPTS[name] as BundledPrompt<PromptValue<N>>;
  const pending = readBundledPrompt(name, row);
  loaded.set(name, pending);
  return pending;
}

/**
 * Render the polish prompt from the YAML template.
 * FILE_CONTEXT goes through nunjucks; user text is appended raw (safe from injection).
 */
export async function renderPolishPrompt(
  fileContext: string,
  text: string,
): Promise<string> {
  const [{ prompts }, { default: nunjucks }] = await Promise.all([
    loadBundledPrompt('polish'),
    import('nunjucks'),
  ]);
  const environment = createTexraNunjucksEnvironment(nunjucks);
  return (
    environment.renderString(prompts.userRequest, {
      FILE_CONTEXT: fileContext,
    }) + text
  );
}

export async function getContinuationTemplate(): Promise<string> {
  return (await loadBundledPrompt('goal')).continuation.template;
}

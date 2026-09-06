/**
 * One loader for every prompt template that ships inside a host's packaged
 * `resources/` bundle.
 *
 * Each host calls `initializeBundledPrompts(resourcesPath)` exactly once at
 * startup with its own resolved resources root, and every prompt below is
 * reachable. There is deliberately no per-prompt initializer: two of them
 * existed (polish and goal), each host had to remember both, and desktop
 * shipped a release that remembered goal and forgot polish — so every desktop
 * follow-up polish failed with "Polish model not initialized" (#10365). A new
 * prompt is another loader behind this one init, never a fourth thing three
 * composition roots must remember.
 *
 * Each prompt owns what an absent or malformed bundle means for it: polish
 * rejects (there is no inline copy to render), while goal substitutes its
 * inline copy — silently when no host wired a bundle at all, and with a
 * warning when a bundle that *should* have loaded could not be read or
 * parsed. So the CLI — whose bundle ships `goal/` but not
 * `templates/instructionPolish.yaml` (`copy-resources.mjs`), and which renders
 * no polish prompt — costs nothing for polish, since prompts are read lazily
 * and a CLI polish caller would fail loudly rather than silently.
 */

// Node imports
import { join } from 'node:path';

// Third-party imports
import { z } from 'zod';

// Local imports
import { Result } from 'effect';
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import { createLog } from '@logger/logUtils';
import { createTexraNunjucksEnvironment } from '@utils/prompt';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';

const log = createLog('BundledPrompts');

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

const PolishPromptsSchema = z.object({
  prompts: z.object({ userRequest: z.string() }),
});

type PolishPrompts = z.infer<typeof PolishPromptsSchema>;

let resourcesRoot: string | null = null;
let polishPrompts: Promise<PolishPrompts> | undefined;
let goalPrompts: Promise<GoalPrompts> | undefined;

/**
 * Point every bundled prompt at the host's packaged `resources/` root.
 *
 * Safe to call repeatedly: a later call replaces the root and drops the cache,
 * so CLI validation can re-enter platform init with a different resources path
 * in the same process.
 */
export function initializeBundledPrompts(resourcesPath: string): void {
  resourcesRoot = resourcesPath;
  polishPrompts = undefined;
  goalPrompts = undefined;
}

/**
 * Read and parse one bundled prompt YAML. Throws when the file cannot be read
 * or does not match `schema`; each caller owns what that means for its prompt.
 */
async function readPromptYaml<T>(
  name: string,
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const content = await AbsoluteFS.read(filePath);
  const parsed = parseYamlWith(content, schema);
  if (Result.isFailure(parsed)) {
    throw new Error(
      `Failed to parse ${name} prompt YAML at ${filePath}: ${parsed.failure.message}`,
      { cause: parsed.failure },
    );
  }
  return parsed.success;
}

/** Required: no inline copy exists, so an unavailable bundle fails the call. */
function loadPolishPrompts(): Promise<PolishPrompts> {
  polishPrompts ??= (async () => {
    const root = resourcesRoot;
    if (root === null) {
      throw new Error(
        'Bundled prompt "polish" is unavailable: no host called initializeBundledPrompts().',
      );
    }
    return readPromptYaml(
      'polish',
      join(root, 'templates', 'instructionPolish.yaml'),
      PolishPromptsSchema,
    );
  })();
  return polishPrompts;
}

/** Falls back to the inline copy: the goal continuation must always render. */
function loadGoalPrompts(): Promise<GoalPrompts> {
  goalPrompts ??= (async () => {
    const root = resourcesRoot;
    // No host wired a bundle (tests, embedders): substitute the inline copy
    // without a warning — nothing failed, there is simply nothing to read.
    if (root === null) return INLINE_GOAL_PROMPTS;
    const filePath = join(root, 'goal', 'goal.yaml');
    try {
      return await readPromptYaml('goal', filePath, GoalPromptsSchema);
    } catch (error) {
      // Warn so a broken or missing bundled file is detectable rather than
      // silently masked by the inline copy.
      log.warn(
        `Failed to load bundled goal prompts from ${filePath}; using inline templates: ${toErrorMessage(error)}`,
      );
      return INLINE_GOAL_PROMPTS;
    }
  })();
  return goalPrompts;
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
    loadPolishPrompts(),
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
  return (await loadGoalPrompts()).continuation.template;
}

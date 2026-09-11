/**
 * The loader for prompt templates that ship inside a host's packaged
 * `resources/` bundle, plus the goal continuation, which is inline.
 *
 * Each host calls `initializeBundledPrompts(resourcesPath)` exactly once at
 * startup with its own resolved resources root. There is deliberately no
 * per-prompt initializer: when two existed, desktop shipped a release that
 * wired one and forgot the other, so every desktop follow-up polish failed
 * with "Polish model not initialized" (#10365).
 *
 * Polish rejects when its bundle is absent or malformed; there is no inline
 * copy to render. The CLI bundle does not ship
 * `templates/instructionPolish.yaml` (`copy-resources.mjs`), and the CLI
 * renders no polish prompt, so this costs it nothing: prompts are read
 * lazily, and a CLI polish caller would fail loudly rather than silently.
 */

// Node imports
import { join } from 'node:path';

// Third-party imports
import { z } from 'zod';

// Local imports
import { Result } from 'effect';
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import { AbsoluteFS } from '@utils/files/absoluteFS';

/**
 * The goal continuation injected at the end of an idle turn while a goal is
 * active. It lives here rather than in a bundled YAML so it always renders,
 * whether or not a host registered a resources root.
 */
export const GOAL_CONTINUATION_TEMPLATE =
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
  ].join('\n') + '\n';

const PolishPromptsSchema = z.object({
  prompts: z.object({ userRequest: z.string() }),
});

type PolishPrompts = z.infer<typeof PolishPromptsSchema>;

let resourcesRoot: string | null = null;
let polishPrompts: Promise<PolishPrompts> | undefined;

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

/**
 * The polish prompt: the YAML instruction prefix followed by the raw user
 * text. Nothing is templated, so user text can't inject template syntax.
 */
export async function renderPolishPrompt(text: string): Promise<string> {
  return (await loadPolishPrompts()).prompts.userRequest + text;
}

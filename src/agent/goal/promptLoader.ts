/**
 * Loader for the packaged Goal prompt templates.
 *
 * Each host calls `initializeGoalPrompts(goalYamlPath)` once at startup with
 * the concrete YAML path from its own resource bundle. The agent code path is
 * host-neutral and reads through this loader; no `vscode` import or package
 * layout knowledge is required.
 *
 * When the loader has not been initialized (e.g. on a host that has not
 * yet wired Goal, or under tests), template lookups fall back to the
 * inline copy in `inlineTemplates` so the continuation loop still works.
 */
import { z } from 'zod';

import { parseYamlWith } from '@common/parsing/safeParseYaml';
import * as logger from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';

const GoalPromptsYamlSchema = z.object({
  continuation: z.object({ template: z.string().min(1) }),
});

type GoalPrompts = z.infer<typeof GoalPromptsYamlSchema>;

// Trailing newline matches the YAML `|` (clip) chomping in goal.yaml so
// the rendered prompt is byte-identical across host-loaded and inline paths.
// Keep this in sync with packages/extension/resources/goal/goal.yaml —
// the YAML is the source of truth; this fallback fires only when the loader
// hasn't been wired (e.g. in tests or under a host that hasn't called
// initializeGoalPrompts).
const inlineTemplates: GoalPrompts = {
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

let goalYamlPath: string | null = null;
let cached: GoalPrompts | null = null;

/**
 * Register the host's Goal prompt YAML path.
 *
 * Safe to call multiple times; later calls replace the path and bust the
 * cache so a previously-loaded inline fallback won't stick once the host
 * is wired.
 */
export function initializeGoalPrompts(pathToGoalYaml: string): void {
  goalYamlPath = pathToGoalYaml;
  cached = null;
}

async function loadPrompts(): Promise<GoalPrompts> {
  if (cached) return cached;
  if (!goalYamlPath) {
    cached = inlineTemplates;
    return cached;
  }
  try {
    const content = await AbsoluteFS.read(goalYamlPath);
    const parsed = parseYamlWith(content, GoalPromptsYamlSchema);
    if (parsed.isErr()) throw parsed.error;
    cached = parsed.value;
  } catch (err) {
    // Fall back to inline templates, but warn so a broken/missing bundled
    // goal.yaml is detectable rather than silently masked.
    logger.warn(
      'GoalPromptLoader',
      `Failed to load bundled goal.yaml; using inline prompt templates: ${toErrorMessage(
        err,
      )}`,
    );
    cached = inlineTemplates;
  }
  return cached;
}

export async function getContinuationTemplate(): Promise<string> {
  return (await loadPrompts()).continuation.template;
}

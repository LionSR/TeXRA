/**
 * Loader for the packaged Odyssey prompt templates
 * (`<extension>/resources/odyssey/odyssey.yaml`).
 *
 * Mirrors the shape of `src/agent/runtime/polishModel.ts`: each host calls
 * `initializeOdysseyPrompts(extensionPath)` once at startup with the path
 * to its own resource bundle. The agent code path is host-neutral and
 * reads through this loader; no `vscode` import is required.
 *
 * When the loader has not been initialized (e.g. on a host that has not
 * yet wired Odyssey, or under tests), template lookups fall back to the
 * inline copy in `inlineTemplates` so the continuation loop still works.
 */
import * as path from 'path';

import * as yaml from 'yaml';
import { z } from 'zod';

import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';

const OdysseyPromptsYamlSchema = z.object({
  continuation: z.object({ template: z.string().min(1) }),
  objective_updated: z.object({ template: z.string().min(1) }),
});

type OdysseyPrompts = z.infer<typeof OdysseyPromptsYamlSchema>;

// Trailing newline matches the YAML `|` (clip) chomping in odyssey.yaml so
// the rendered prompt is byte-identical across host-loaded and inline paths.
// Keep this in sync with packages/extension/resources/odyssey/odyssey.yaml —
// the YAML is the source of truth; this fallback fires only when the loader
// hasn't been wired (e.g. in tests or under a host that hasn't called
// initializeOdysseyPrompts).
const inlineTemplates: OdysseyPrompts = {
  continuation: {
    template:
      [
        '<odyssey_context>',
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
        '</odyssey_context>',
      ].join('\n') + '\n',
  },
  objective_updated: {
    template:
      [
        '<odyssey_context>',
        'The user has edited the objective. The new objective supersedes any',
        'previous one.',
        '',
        '<objective>',
        '{{objective}}',
        '</objective>',
        '',
        'Re-orient against the new objective. Drop work that only served the',
        "previous one. Consider it done only when the new objective's end state",
        'is true and verified against current evidence.',
        '</odyssey_context>',
      ].join('\n') + '\n',
  },
};

let extensionPath: string | null = null;
let cached: OdysseyPrompts | null = null;

/**
 * Register the host's resource root. The Odyssey YAML is resolved at
 * `<extensionPath>/resources/odyssey/odyssey.yaml` on first use.
 *
 * Safe to call multiple times; later calls replace the path and bust the
 * cache so a previously-loaded inline fallback won't stick once the host
 * is wired.
 */
export function initializeOdysseyPrompts(extPath: string): void {
  extensionPath = extPath;
  cached = null;
}

async function loadPrompts(): Promise<OdysseyPrompts> {
  if (cached) return cached;
  if (!extensionPath) {
    cached = inlineTemplates;
    return cached;
  }
  try {
    const yamlPath = path.join(
      extensionPath,
      'resources',
      'odyssey',
      'odyssey.yaml',
    );
    const content = await AbsoluteFS.read(yamlPath);
    cached = OdysseyPromptsYamlSchema.parse(yaml.parse(content));
  } catch (err) {
    // Fall back to inline templates, but warn so a broken/missing bundled
    // odyssey.yaml is detectable rather than silently masked.
    logger.warn(
      'OdysseyPromptLoader',
      `Failed to load bundled odyssey.yaml; using inline prompt templates: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    cached = inlineTemplates;
  }
  return cached;
}

export async function getContinuationTemplate(): Promise<string> {
  return (await loadPrompts()).continuation.template;
}

export async function getObjectiveUpdatedTemplate(): Promise<string> {
  return (await loadPrompts()).objective_updated.template;
}

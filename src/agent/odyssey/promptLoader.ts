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
        'Odyssey active. Continue working toward the objective; do not end',
        'the turn just because there is something quotable to summarize.',
        '',
        '<objective>',
        '{{objective}}',
        '</objective>',
        '',
        'Time elapsed: {{timeUsed}}',
        '',
        'Keep scope:',
        '- Do not redefine success around a smaller or easier task. Make',
        '  concrete progress toward the requested end state and leave the',
        '  odyssey active if it cannot finish this turn.',
        '- Do not substitute a narrower, safer, or merely test-passing',
        '  solution for the behavior the objective actually requests.',
        '',
        'Completion audit (treat completion as unproven until verified):',
        '- Derive every requirement from the objective and any referenced',
        '  files, plans, issues, or specs. For each requirement, identify',
        '  authoritative evidence (file contents, command output, test',
        '  results, PR state, runtime behavior) and inspect it now.',
        '- Match verification scope to requirement scope; do not use a',
        '  narrow check to support a broad claim.',
        '- Uncertain or indirect evidence is not proof. Gather stronger',
        '  evidence or keep working.',
        '- The audit must prove completion, not merely fail to find',
        '  remaining work.',
        '',
        'Only call `plan(command="complete")` when current evidence proves',
        'every requirement is satisfied; cite that evidence in `reason`.',
        'Otherwise keep working in scoped checkpoints. Self-pause via',
        '`plan(command="pause")` only when you genuinely need user input',
        'to proceed.',
        '</odyssey_context>',
      ].join('\n') + '\n',
  },
  objective_updated: {
    template:
      [
        '<odyssey_context>',
        'The user has edited the Odyssey objective. The new objective',
        'supersedes any previous one.',
        '',
        '<objective>',
        '{{objective}}',
        '</objective>',
        '',
        'Re-orient against the new objective. Avoid continuing work that',
        'only served the previous one. Do not call',
        '`plan(command="complete")` unless the updated objective is',
        'actually complete, with current evidence proving every',
        'requirement is satisfied.',
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
  } catch {
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

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

const inlineTemplates: OdysseyPrompts = {
  continuation: {
    template: [
      '<odyssey_context>',
      'Your odyssey is in progress.',
      '',
      'Objective: {{objective}}',
      'Time elapsed: {{timeUsed}}',
      '',
      'Verify against the actual filesystem and command output — not your',
      'memory — whether the objective and its stopping condition are met.',
      'If yes, call `odyssey` with command="complete" and a reason citing',
      'the verification evidence. If not, continue working in scoped',
      'checkpoints.',
      '</odyssey_context>',
    ].join('\n'),
  },
  objective_updated: {
    template: [
      '<odyssey_context>',
      'The user has updated the odyssey objective. This overrides earlier context.',
      '',
      'New objective: {{objective}}',
      '',
      'Re-orient against the new objective before continuing.',
      '</odyssey_context>',
    ].join('\n'),
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

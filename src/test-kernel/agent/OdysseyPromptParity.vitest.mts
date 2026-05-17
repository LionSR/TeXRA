// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

interface OdysseyPromptsYaml {
  continuation: { template: string };
  objective_updated: { template: string };
}

function readYaml(): OdysseyPromptsYaml {
  const text = readFileSync(
    resolve(REPO_ROOT, 'packages/extension/resources/odyssey/odyssey.yaml'),
    'utf8',
  );
  return yaml.parse(text) as OdysseyPromptsYaml;
}

function readInlineFallbackSource(): string {
  return readFileSync(
    resolve(REPO_ROOT, 'src/agent/odyssey/promptLoader.ts'),
    'utf8',
  );
}

// The inline fallback in promptLoader.ts ships verbatim to hosts that
// haven't called initializeOdysseyPrompts (tests, partial wiring, file-read
// errors). Drift between the two paths would silently disable the
// completion-audit discipline. Both must render the same template.
describe('Odyssey prompt parity (YAML ↔ inline fallback)', () => {
  it('continuation template in YAML is fully reflected in the inline fallback', () => {
    const ymlTemplate = readYaml().continuation.template;
    const loader = readInlineFallbackSource();

    // The fallback is built from string-array `.join('\n')` literals, so
    // we can't compare full bytes. Instead require that every non-trivial
    // line of the YAML template appears verbatim in the loader source.
    const lines = ymlTemplate.split('\n').filter((l) => l.trim().length >= 4);
    for (const line of lines) {
      expect(
        loader,
        `Inline fallback in promptLoader.ts is missing this continuation line — update both files in lockstep:\n  ${line}`,
      ).toContain(line);
    }
  });

  it('objective_updated template in YAML is fully reflected in the inline fallback', () => {
    const ymlTemplate = readYaml().objective_updated.template;
    const loader = readInlineFallbackSource();
    const lines = ymlTemplate.split('\n').filter((l) => l.trim().length >= 4);
    for (const line of lines) {
      expect(
        loader,
        `Inline fallback in promptLoader.ts is missing this objective_updated line — update both files in lockstep:\n  ${line}`,
      ).toContain(line);
    }
  });
});

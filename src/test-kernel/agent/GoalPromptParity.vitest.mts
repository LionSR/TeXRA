// Node imports
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

// Local imports
import {
  getContinuationTemplate,
  initializeGoalPrompts,
} from '@agent/goal/promptLoader';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

interface GoalPromptsYaml {
  continuation: { template: string };
}

function readYaml(): GoalPromptsYaml {
  const text = readFileSync(
    resolve(REPO_ROOT, 'packages/extension/resources/goal/goal.yaml'),
    'utf8',
  );
  return yaml.parse(text) as GoalPromptsYaml;
}

function readInlineFallbackSource(): string {
  return readFileSync(
    resolve(REPO_ROOT, 'src/agent/goal/promptLoader.ts'),
    'utf8',
  );
}

// The inline fallback in promptLoader.ts ships verbatim to hosts that
// haven't called initializeGoalPrompts (tests, partial wiring, file-read
// errors). Drift between the two paths would silently disable the
// completion-audit discipline. Both must render the same template.
describe('Goal prompt parity (YAML ↔ inline fallback)', () => {
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

  it('loads the host-provided goal YAML path directly', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}, { fs: nodeFilesystem }));
    const yamlPath = resolve(
      REPO_ROOT,
      'packages/extension/resources/goal/goal.yaml',
    );
    initializeGoalPrompts(yamlPath);

    await expect(getContinuationTemplate()).resolves.toBe(
      readYaml().continuation.template,
    );
  });

  it('falls back to the inline template instead of throwing on malformed goal YAML', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}, { fs: nodeFilesystem }));

    const dir = await mkdtemp(resolve(tmpdir(), 'texra-goal-'));
    const brokenPath = resolve(dir, 'broken.yaml');
    await writeFile(brokenPath, 'continuation:\n  template: "unterminated\n');
    initializeGoalPrompts(brokenPath);

    const template = await getContinuationTemplate();
    expect(template).toContain('Autonomous objective active');
  });
});

import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import {
  getContinuationTemplate,
  initializeGoalPrompts,
} from '@agent/goal/promptLoader';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { REPO_ROOT } from '@test/support/repoScan';
import { setupPlatform } from '@test/support/setupPlatform';

interface GoalPromptsYaml {
  continuation: { template: string };
}

const GOAL_YAML_PATH = resolve(
  REPO_ROOT,
  'packages/extension/resources/goal/goal.yaml',
);

const goalYaml = yaml.parse(
  readFileSync(GOAL_YAML_PATH, 'utf8'),
) as GoalPromptsYaml;

// The inline fallback in promptLoader.ts ships verbatim to hosts that
// haven't called initializeGoalPrompts (tests, partial wiring, file-read
// errors). Drift between the two paths would silently disable the
// completion-audit discipline. Both must render the same template.
describe('Goal prompt parity (YAML ↔ inline fallback)', () => {
  setupPlatform({}, { fs: nodeFilesystem });

  it('continuation template in YAML is fully reflected in the inline fallback', () => {
    const loader = readFileSync(
      resolve(REPO_ROOT, 'src/agent/goal/promptLoader.ts'),
      'utf8',
    );

    // The fallback is built from string-array `.join('\n')` literals, so
    // we can't compare full bytes. Instead require that every non-trivial
    // line of the YAML template appears verbatim in the loader source.
    const lines = goalYaml.continuation.template
      .split('\n')
      .filter((l) => l.trim().length >= 4);
    for (const line of lines) {
      expect(
        loader,
        `Inline fallback in promptLoader.ts is missing this continuation line — update both files in lockstep:\n  ${line}`,
      ).toContain(line);
    }
  });

  it('loads the host-provided goal YAML path directly', async () => {
    initializeGoalPrompts(GOAL_YAML_PATH);

    await expect(getContinuationTemplate()).resolves.toBe(
      goalYaml.continuation.template,
    );
  });

  it('falls back to the inline template instead of throwing on malformed goal YAML', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'texra-goal-'));
    const brokenPath = resolve(dir, 'broken.yaml');
    await writeFile(brokenPath, 'continuation:\n  template: "unterminated\n');
    initializeGoalPrompts(brokenPath);

    const template = await getContinuationTemplate();
    expect(template).toContain('Autonomous objective active');
  });
});

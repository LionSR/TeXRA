// Node imports
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

// Local imports
import {
  getContinuationTemplate,
  initializeBundledPrompts,
  renderPolishPrompt,
} from '@agent/runtime/bundledPrompts';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { REPO_ROOT } from '@test/support/repoScan';
import { setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

interface GoalPromptsYaml {
  continuation: { template: string };
}

// The shipped bundle every host resolves at startup. Loading through it (rather
// than through a per-prompt path) is what pins each loader's relative path to
// the real resource layout.
const RESOURCES_PATH = resolve(REPO_ROOT, 'packages/extension/resources');
const GOAL_YAML_PATH = join(RESOURCES_PATH, 'goal', 'goal.yaml');

const goalYaml = yaml.parse(
  readFileSync(GOAL_YAML_PATH, 'utf8'),
) as GoalPromptsYaml;

describe('bundled prompt loader', () => {
  setupPlatform({}, { fs: nodeFilesystem });

  const tempDirs = useTempDirs();

  /** A resources root whose two prompt files are both unparseable YAML. */
  async function makeBrokenResources(): Promise<string> {
    const root = await makeTempDir('texra-bundled-prompts-', tempDirs);
    await Promise.all([
      mkdir(join(root, 'templates'), { recursive: true }),
      mkdir(join(root, 'goal'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(root, 'templates', 'instructionPolish.yaml'),
        'prompts:\n  userRequest: "unterminated\n',
      ),
      writeFile(
        join(root, 'goal', 'goal.yaml'),
        'continuation:\n  template: "unterminated\n',
      ),
    ]);
    return root;
  }

  it('renders the polish prompt from the packaged resource bundle', async () => {
    initializeBundledPrompts(RESOURCES_PATH);

    const prompt = await renderPolishPrompt('<paper & notes>', 'Fix teh typo.');

    expect(prompt).toContain('Correct any spelling errors');
    expect(prompt).toContain('<paper & notes>');
    expect(prompt).toContain('Fix teh typo.');
  });

  it('rejects with a wrapped error for malformed polish prompt YAML', async () => {
    const root = await makeBrokenResources();
    initializeBundledPrompts(root);

    await expect(renderPolishPrompt('', 'text')).rejects.toThrow(
      `Failed to parse polish prompt YAML at ${join(root, 'templates', 'instructionPolish.yaml')}`,
    );
  });

  it('loads the goal continuation template from the packaged resource bundle', async () => {
    initializeBundledPrompts(RESOURCES_PATH);

    await expect(getContinuationTemplate()).resolves.toBe(
      goalYaml.continuation.template,
    );
  });

  it('falls back to the inline template instead of throwing on malformed goal YAML', async () => {
    const root = await makeBrokenResources();
    initializeBundledPrompts(root);

    await expect(getContinuationTemplate()).resolves.toContain(
      'Autonomous objective active',
    );
  });
});

// The inline fallback in bundledPrompts.ts ships verbatim to hosts that
// haven't wired the bundle (tests, partial wiring, file-read errors). Drift
// between the two paths would silently disable the completion-audit
// discipline. Both must render the same template.

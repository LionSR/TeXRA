// Node imports
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  initializePolishModel,
  renderPolishPrompt,
} from '@agent/runtime/polishModel';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { REPO_ROOT } from '@test/support/repoScan';
import { setupPlatform } from '@test/support/setupPlatform';

describe('polish prompt loader', () => {
  setupPlatform({}, { fs: nodeFilesystem });

  it('loads the host-provided polish YAML path directly', async () => {
    initializePolishModel(
      resolve(
        REPO_ROOT,
        'packages/extension/resources/templates/instructionPolish.yaml',
      ),
    );

    const prompt = await renderPolishPrompt('', 'Fix teh typo.');

    expect(prompt).toContain('Correct any spelling errors');
    expect(prompt).toContain('Fix teh typo.');
  });

  it('rejects with a wrapped error for malformed polish prompt YAML', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'texra-polish-'));
    const brokenPath = resolve(dir, 'broken.yaml');
    await writeFile(brokenPath, 'prompts:\n  userRequest: "unterminated\n');
    initializePolishModel(brokenPath);

    await expect(renderPolishPrompt('', 'text')).rejects.toThrow(
      `Failed to parse polish prompt YAML at ${brokenPath}`,
    );
  });
});

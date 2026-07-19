// Node imports
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  initializePolishModel,
  renderPolishPrompt,
} from '@agent/runtime/polishModel';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

describe('polish prompt loader', () => {
  it('loads the host-provided polish YAML path directly', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}, { fs: nodeFilesystem }));
    initializePolishModel(
      resolve(
        REPO_ROOT,
        'packages/extension/resources/templates/instructionPolish.yaml',
      ),
    );

    const prompt = await renderPolishPrompt('', 'Fix teh typo.');

    expect(prompt).toContain('Please review the following instruction text');
    expect(prompt).toContain('Fix teh typo.');
  });

  it('rejects with a wrapped error for malformed polish prompt YAML', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}, { fs: nodeFilesystem }));

    const dir = await mkdtemp(resolve(tmpdir(), 'texra-polish-'));
    const brokenPath = resolve(dir, 'broken.yaml');
    await writeFile(brokenPath, 'prompts:\n  userRequest: "unterminated\n');
    initializePolishModel(brokenPath);

    await expect(renderPolishPrompt('', 'text')).rejects.toThrow(
      `Failed to parse polish prompt YAML at ${brokenPath}`,
    );
  });
});

// Node imports
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - platform
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';

// Local imports - agent runtime
import {
  initializePolishModel,
  renderPolishPrompt,
} from '@agent/runtime/polishModel';

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
});

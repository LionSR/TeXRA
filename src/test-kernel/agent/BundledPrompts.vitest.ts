// Node imports
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  initializeBundledPrompts,
  renderPolishPrompt,
} from '@agent/runtime/bundledPrompts';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { REPO_ROOT } from '@test/support/repoScan';
import { setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

// The shipped bundle every host resolves at startup. Loading through it (rather
// than through a per-prompt path) is what pins each loader's relative path to
// the real resource layout.
const RESOURCES_PATH = resolve(REPO_ROOT, 'packages/extension/resources');

describe('bundled prompt loader', () => {
  setupPlatform({}, { fs: nodeFilesystem });

  const tempDirs = useTempDirs();

  /** A resources root whose polish prompt file is unparseable YAML. */
  async function makeBrokenResources(): Promise<string> {
    const root = await makeTempDir('texra-bundled-prompts-', tempDirs);
    await mkdir(join(root, 'templates'), { recursive: true });
    await writeFile(
      join(root, 'templates', 'instructionPolish.yaml'),
      'prompts:\n  userRequest: "unterminated\n',
    );
    return root;
  }

  it('renders the polish prompt from the packaged resource bundle', async () => {
    initializeBundledPrompts(RESOURCES_PATH);

    const prompt = await renderPolishPrompt('Fix teh typo.');

    expect(prompt).toContain('Correct any spelling errors');
    expect(prompt).toContain('Fix teh typo.');
  });

  it('rejects with a wrapped error for malformed polish prompt YAML', async () => {
    const root = await makeBrokenResources();
    initializeBundledPrompts(root);

    await expect(renderPolishPrompt('text')).rejects.toThrow(
      `Failed to parse polish prompt YAML at ${join(root, 'templates', 'instructionPolish.yaml')}`,
    );
  });
});

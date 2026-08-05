import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createStdinWorkflowInputMaterializer,
  expandWorkflowInputSpecs,
  withExpandedRunInputs,
} from '@cli/runtime/workflowInputs';
import { createFakePlatform } from '@test/support/FakePlatform';

describe('CLI workflow input lifecycle', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-stdin-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function installFakePlatform() {
    const fakePlatform = createFakePlatform({
      globalStoragePath: path.join(root, 'global-storage'),
      storagePath: path.join(root, 'workspace-storage'),
      workspacePath: root,
    });
    const { initPlatform } = await import('@platform/platform');
    initPlatform(fakePlatform);
    return fakePlatform;
  }

  it('removes materialized stdin input on platform shutdown', async () => {
    const fakePlatform = await installFakePlatform();

    const stdinInputFile = createStdinWorkflowInputMaterializer({
      tempDir: root,
      readStdinText: async () => 'body from stdin',
    });

    const expanded = await expandWorkflowInputSpecs(['-'], root, '--input', {
      stdinInputFile,
    });

    const inputPath = path.resolve(root, expanded[0]);
    await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe(
      'body from stdin',
    );

    await fakePlatform.lifecycle.runShutdown();
    await expect(fs.stat(inputPath)).rejects.toThrow();
  });

  it('does not wait for unfinished stdin reads during platform shutdown', async () => {
    const fakePlatform = await installFakePlatform();

    const stdinInputFile = createStdinWorkflowInputMaterializer({
      tempDir: root,
      readStdinText: async () => new Promise<string>(() => undefined),
    });

    void stdinInputFile().catch(() => undefined);
    const result = await Promise.race([
      fakePlatform.lifecycle.runShutdown().then(() => 'shutdown'),
      sleep(100).then(() => 'timeout'),
    ]);

    expect(result).toBe('shutdown');
  });

  it('removes materialized stdin input when the headless run callback fails', async () => {
    await installFakePlatform();
    let materializedPath = '';

    await expect(
      withExpandedRunInputs(
        ['-'],
        [],
        root,
        { readStdinText: async () => 'body from stdin' },
        async ({ inputFiles }) => {
          const inputPath = inputFiles.at(0);
          if (!inputPath) throw new Error('missing materialized input');
          materializedPath = path.resolve(root, inputPath);
          await expect(fs.readFile(materializedPath, 'utf8')).resolves.toBe(
            'body from stdin',
          );
          throw new Error('run failed');
        },
      ),
    ).rejects.toThrow('run failed');

    await expect(fs.stat(materializedPath)).rejects.toThrow();
  });
});

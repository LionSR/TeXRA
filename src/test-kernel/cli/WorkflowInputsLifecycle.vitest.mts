import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import {
  createStdinWorkflowInputMaterializer,
  expandWorkflowInputSpecs,
} from '@cli/runtime/workflowInputs';

describe('CLI workflow input lifecycle', () => {
  async function installFakePlatform(root: string) {
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-stdin-'));
    const fakePlatform = await installFakePlatform(root);

    try {
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
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not wait for unfinished stdin reads during platform shutdown', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-stdin-'));
    const fakePlatform = await installFakePlatform(root);

    try {
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
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

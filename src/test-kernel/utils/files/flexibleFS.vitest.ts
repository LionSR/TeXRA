// Third-party imports
import * as assert from 'node:assert';
import { describe, it } from 'vitest';

// Internal imports
import { flexibleFS } from '@utils/files/flexibleFS';
import { pathToLocation } from '@utils/files/taskRunStorage';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';

describe('flexibleFS.write', () => {
  it('retries the write after clearing symlink loops', async () => {
    const originalWrite = AbsoluteFS.write;
    const originalDelete = AbsoluteFS.delete;

    const writes: string[] = [];
    let deleteTarget: string | undefined;
    let attempt = 0;

    try {
      (AbsoluteFS as unknown as { write: typeof AbsoluteFS.write }).write =
        (async (target: string, content: string | Uint8Array) => {
          writes.push(target);
          attempt += 1;
          if (attempt === 1) {
            const error = new Error('loop detected') as NodeJS.ErrnoException;
            error.code = 'ELOOP';
            throw error;
          }

          const resolvedContent =
            typeof content === 'string'
              ? content
              : Buffer.from(content).toString('utf-8');
          assert.strictEqual(resolvedContent, 'content');
        }) as typeof AbsoluteFS.write;

      (AbsoluteFS as unknown as { delete: typeof AbsoluteFS.delete }).delete =
        (async (
          target: string,
          options?: { recursive?: boolean; useTrash?: boolean },
        ) => {
          deleteTarget = target;
          assert.deepEqual(options, { recursive: true, useTrash: false });
        }) as typeof AbsoluteFS.delete;

      const location = pathToLocation('file.tex');
      const expectedPath = WorkspaceFS.toAbsolute('file.tex');
      await flexibleFS.write(location, 'content');

      assert.deepEqual(writes, [expectedPath, expectedPath]);
      assert.strictEqual(deleteTarget, expectedPath);
    } finally {
      (AbsoluteFS as unknown as { write: typeof AbsoluteFS.write }).write =
        originalWrite;
      (AbsoluteFS as unknown as { delete: typeof AbsoluteFS.delete }).delete =
        originalDelete;
    }
  });
});

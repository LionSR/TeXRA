// Node.js built-in imports
import * as assert from 'assert';

// Internal imports
import { flexibleFS } from '@utils/files/flexibleFS';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';

describe('flexibleFS.write', () => {
  it('retries workspace write after clearing symlink loops', async () => {
    const originalWrite = WorkspaceFS.write;
    const originalFullPath = WorkspaceFS.fullPath;
    const originalDelete = AbsoluteFS.delete;

    const writes: string[] = [];
    let deleteTarget: string | undefined;
    let attempt = 0;

    try {
      (WorkspaceFS as unknown as { write: typeof WorkspaceFS.write }).write =
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
        }) as typeof WorkspaceFS.write;

      (
        WorkspaceFS as unknown as { fullPath: typeof WorkspaceFS.fullPath }
      ).fullPath = ((target: string) =>
        `/tmp/workspace/${target}`) as typeof WorkspaceFS.fullPath;

      (AbsoluteFS as unknown as { delete: typeof AbsoluteFS.delete }).delete =
        (async (
          target: string,
          options?: { recursive?: boolean; useTrash?: boolean },
        ) => {
          deleteTarget = target;
          assert.deepEqual(options, { recursive: true, useTrash: false });
        }) as typeof AbsoluteFS.delete;

      await flexibleFS.write('file.tex', 'content');

      assert.deepEqual(writes, ['file.tex', 'file.tex']);
      assert.strictEqual(deleteTarget, '/tmp/workspace/file.tex');
    } finally {
      (WorkspaceFS as unknown as { write: typeof WorkspaceFS.write }).write =
        originalWrite;
      (
        WorkspaceFS as unknown as { fullPath: typeof WorkspaceFS.fullPath }
      ).fullPath = originalFullPath;
      (AbsoluteFS as unknown as { delete: typeof AbsoluteFS.delete }).delete =
        originalDelete;
    }
  });
});

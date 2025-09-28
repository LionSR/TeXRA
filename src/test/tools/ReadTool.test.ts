import * as assert from 'assert';

import { ReadFileTool, READ_FILE_MAX_LINES } from '@tools/ReadTool';
import { WorkspaceFS } from '@utils/files';

suite('ReadFileTool', () => {
  test('truncates output when file exceeds maximum lines', async () => {
    const tool = new ReadFileTool();
    const originalRead = WorkspaceFS.read;

    const totalLines = READ_FILE_MAX_LINES + 10;
    const content = Array.from(
      { length: totalLines },
      (_, index) => `line ${index + 1}`,
    ).join('\n');

    (WorkspaceFS as unknown as { read: typeof WorkspaceFS.read }).read =
      async () => content;

    try {
      const result = await tool.call({ path: 'long.txt' });

      assert.strictEqual(
        result.summary,
        `Read long.txt (first ${READ_FILE_MAX_LINES} of ${totalLines} lines)`,
      );

      assert.ok(result.output, 'Expected tool output when truncating file');

      const outputLines = result.output!.split('\n');
      assert.strictEqual(
        outputLines.length,
        READ_FILE_MAX_LINES + 1,
        'Output should include the limit and truncation marker line',
      );
      assert.strictEqual(outputLines[0], 'line 1');
      assert.strictEqual(
        outputLines[READ_FILE_MAX_LINES - 1],
        `line ${READ_FILE_MAX_LINES}`,
      );
      assert.strictEqual(
        outputLines[READ_FILE_MAX_LINES],
        `...(truncated, ${totalLines - READ_FILE_MAX_LINES} more lines)`,
      );
    } finally {
      (WorkspaceFS as unknown as { read: typeof WorkspaceFS.read }).read =
        originalRead;
    }
  });

  test('returns complete content when file is within limit', async () => {
    const tool = new ReadFileTool();
    const originalRead = WorkspaceFS.read;

    const totalLines = READ_FILE_MAX_LINES - 5;
    const content = Array.from(
      { length: totalLines },
      (_, index) => `entry ${index + 1}`,
    ).join('\n');

    (WorkspaceFS as unknown as { read: typeof WorkspaceFS.read }).read =
      async () => content;

    try {
      const result = await tool.call({ path: 'short.txt' });

      assert.strictEqual(result.summary, 'Read short.txt');
      assert.strictEqual(result.output, content);
    } finally {
      (WorkspaceFS as unknown as { read: typeof WorkspaceFS.read }).read =
        originalRead;
    }
  });
});

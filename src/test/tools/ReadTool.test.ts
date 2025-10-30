import * as assert from 'assert';

import { ReadFileTool, READ_FILE_MAX_LINES } from '@tools/ReadTool';
import { WorkspaceFS } from '@utils/files';

suite('ReadFileTool', () => {
  let originalRead: typeof WorkspaceFS.read;
  let originalExists: typeof WorkspaceFS.exists;
  let originalStat: typeof WorkspaceFS.stat;
  let originalReadFileBytes: typeof WorkspaceFS.readFileBytes;

  setup(() => {
    originalRead = WorkspaceFS.read;
    originalExists = WorkspaceFS.exists;
    originalStat = WorkspaceFS.stat;
    originalReadFileBytes = WorkspaceFS.readFileBytes;
  });

  teardown(() => {
    WorkspaceFS.read = originalRead;
    WorkspaceFS.exists = originalExists;
    WorkspaceFS.stat = originalStat;
    WorkspaceFS.readFileBytes = originalReadFileBytes;
  });

  test('truncates output when file exceeds maximum lines', async () => {
    const tool = new ReadFileTool();

    const totalLines = READ_FILE_MAX_LINES + 10;
    const content = Array.from(
      { length: totalLines },
      (_, index) => `line ${index + 1}`,
    ).join('\n');

    WorkspaceFS.read = async () => content;

    const result = await tool.call({ path: 'long.txt' });

    assert.strictEqual(result.summary, 'Read lines 1-400 of long.txt');

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
  });

  test('returns complete content when file is within limit', async () => {
    const tool = new ReadFileTool();

    const totalLines = READ_FILE_MAX_LINES - 5;
    const content = Array.from(
      { length: totalLines },
      (_, index) => `entry ${index + 1}`,
    ).join('\n');

    WorkspaceFS.read = async () => content;

    const result = await tool.call({ path: 'short.txt' });

    assert.strictEqual(result.summary, 'Read short.txt');
    assert.strictEqual(result.output, content);
  });

  test('reads requested range beyond 400th line', async () => {
    const tool = new ReadFileTool();

    const totalLines = READ_FILE_MAX_LINES + 50;
    const content = Array.from(
      { length: totalLines },
      (_, index) => `row ${index + 1}`,
    ).join('\n');

    WorkspaceFS.read = async () => content;

    const result = await tool.call({
      path: 'paged.txt',
      range: { start: 401, end: 450 },
    });

    assert.strictEqual(result.summary, 'Read lines 401-450 of paged.txt');
    const outputLines = result.output?.split('\n') ?? [];
    assert.strictEqual(outputLines.length, 50);
    assert.strictEqual(outputLines[0], 'row 401');
    assert.strictEqual(outputLines[outputLines.length - 1], 'row 450');
  });

  test('notes when requested range exceeds file length', async () => {
    const tool = new ReadFileTool();

    const totalLines = READ_FILE_MAX_LINES + 50;
    const content = Array.from(
      { length: totalLines },
      (_, index) => `row ${index + 1}`,
    ).join('\n');

    WorkspaceFS.read = async () => content;

    const result = await tool.call({
      path: 'clipped.txt',
      range: { start: 401, end: totalLines + 50 },
    });

    assert.strictEqual(
      result.summary,
      `Read lines 401-450 of clipped.txt (requested end ${totalLines + 50} exceeds file length ${totalLines})`,
    );
  });

  test('indicates when the requested window lies beyond the file bounds', async () => {
    const tool = new ReadFileTool();

    const totalLines = READ_FILE_MAX_LINES;
    const content = Array.from(
      { length: totalLines },
      (_, index) => `row ${index + 1}`,
    ).join('\n');

    WorkspaceFS.read = async () => content;

    const result = await tool.call({
      path: 'out-of-range.txt',
      range: { start: totalLines + 10, end: totalLines + 20 },
    });

    assert.strictEqual(
      result.summary,
      'Read out-of-range.txt (no lines in requested range)',
    );
    assert.strictEqual(result.output, '');
  });

  test('handles single-line range correctly', async () => {
    const tool = new ReadFileTool();

    const content = Array.from(
      { length: 10 },
      (_, index) => `line ${index + 1}`,
    ).join('\n');

    WorkspaceFS.read = async () => content;

    const result = await tool.call({
      path: 'single.txt',
      range: { start: 5, end: 5 },
    });

    assert.strictEqual(result.summary, 'Read line 5 of single.txt');
    assert.strictEqual(result.output, 'line 5');
  });

  test('handles empty file gracefully', async () => {
    const tool = new ReadFileTool();

    WorkspaceFS.read = async () => '';

    const result = await tool.call({ path: 'empty.txt' });

    assert.strictEqual(result.summary, 'Read empty.txt (file is empty)');
    assert.strictEqual(result.output, '');
  });

  test('returns pdf as attachment without text rendering', async () => {
    const tool = new ReadFileTool();

    let readCalled = false;
    WorkspaceFS.read = async () => {
      readCalled = true;
      throw new Error('Should not read PDF as text');
    };
    WorkspaceFS.exists = async () => true;
    WorkspaceFS.stat = async () =>
      ({ size: 1024 } as Awaited<ReturnType<typeof originalStat>>);
    WorkspaceFS.readFileBytes = async () => Buffer.from('%PDF-1.7');

    const result = await tool.call({ path: 'docs/sample.pdf' });

    assert.strictEqual(readCalled, false, 'PDF read should bypass text reader');
    assert.strictEqual(
      result.summary,
      'Attached PDF docs/sample.pdf.',
    );
    assert.ok(result.output?.includes('attachment'));
    assert.ok(result.output?.includes('models'));

    const attachment = result.files?.[0];
    assert.ok(attachment, 'Expected PDF attachment');
    assert.strictEqual(attachment.mimeType, 'application/pdf');
    assert.ok(attachment.bytes instanceof Uint8Array);
  });

  test('defaults range end to start + 399 when only start provided', async () => {
    const tool = new ReadFileTool();

    const totalLines = 1000;
    const content = Array.from(
      { length: totalLines },
      (_, index) => `line ${index + 1}`,
    ).join('\n');

    WorkspaceFS.read = async () => content;

    const result = await tool.call({
      path: 'windowed.txt',
      range: { start: 100 },
    });

    // Should read lines 100-499 (400 lines)
    assert.strictEqual(result.summary, 'Read lines 100-499 of windowed.txt');
    const outputLines = result.output?.split('\n') ?? [];
    assert.strictEqual(outputLines.length, 400);
    assert.strictEqual(outputLines[0], 'line 100');
    assert.strictEqual(outputLines[399], 'line 499');
  });

  test('handles range starting at line 1 with end exceeding file length', async () => {
    const tool = new ReadFileTool();

    const totalLines = 50;
    const content = Array.from(
      { length: totalLines },
      (_, index) => `line ${index + 1}`,
    ).join('\n');

    WorkspaceFS.read = async () => content;

    const result = await tool.call({
      path: 'clipped-start.txt',
      range: { start: 1, end: totalLines + 50 },
    });

    assert.strictEqual(
      result.summary,
      `Read lines 1-50 of clipped-start.txt (requested end ${totalLines + 50} exceeds file length ${totalLines})`,
    );
    const outputLines = result.output?.split('\n') ?? [];
    assert.strictEqual(outputLines.length, 50);
    assert.strictEqual(outputLines[0], 'line 1');
    assert.strictEqual(outputLines[49], 'line 50');
  });
});

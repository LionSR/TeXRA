// Node imports
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeFileAtomicMock = vi.hoisted(() => vi.fn());

vi.mock('write-file-atomic', () => ({
  default: writeFileAtomicMock,
}));

type Module = typeof import('@desktop/main/desktopLegacyStreamImporter');

type LegacyRow = Record<string, unknown> & { streamId: string };

async function loadModule(): Promise<Module> {
  return import('@desktop/main/desktopLegacyStreamImporter');
}

function makeLegacyRow(
  streamId: string,
  overrides: Record<string, unknown> = {},
): LegacyRow {
  return {
    streamId,
    label: `Legacy ${streamId}`,
    agent: 'workflowAgent',
    agentCategory: 'workflow',
    inputFile: 'paper.tex',
    instruction: 'Polish the proof',
    lastKnownStatus: 'stopped',
    description: 'Private legacy description',
    executionId: 'abc-123',
    creationTimestamp: 1_700_000_000_000,
    lastTimestamp: 1_700_000_500_000,
    persistedAt: 1_700_000_500_500,
    config: { rounds: 3 },
    metadata: { private: true },
    ...overrides,
  };
}

function serializeLegacyRows(rows: LegacyRow[]): string {
  return `${JSON.stringify(
    {
      restoredStreams: {
        version: 1,
        streams: rows,
      },
    },
    null,
    2,
  )}\n`;
}

describe('DesktopLegacyStreamImporter', () => {
  let tempDir: string | undefined;
  let filePath: string;
  let prepareDesktopLegacyStreamImport: Module['prepareDesktopLegacyStreamImport'];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-legacy-stream-import-'));
    filePath = join(tempDir, 'streams.json');
    ({ prepareDesktopLegacyStreamImport } = await loadModule());
    writeFileAtomicMock.mockReset().mockImplementation(async (target, data) => {
      await writeFile(target, data);
    });
  });

  afterEach(async () => {
    if (tempDir == null) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('returns no claims when the legacy file is missing', async () => {
    const prepared = await prepareDesktopLegacyStreamImport(filePath, {
      transcriptStreamIds: ['workflow@1'],
    });

    expect(prepared.claims).toEqual([]);
    await expect(prepared.commit(['workflow@1'])).resolves.toBeUndefined();
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['malformed JSON', '{"restoredStreams"'],
    [
      'invalid version-1 rows',
      JSON.stringify({
        restoredStreams: { version: 1, streams: [{ streamId: 'workflow@1' }] },
      }),
    ],
  ])('fails on %s without changing the source', async (_, original) => {
    await writeFile(filePath, original);

    await expect(
      prepareDesktopLegacyStreamImport(filePath, {
        transcriptStreamIds: ['workflow@1'],
      }),
    ).rejects.toThrow();
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it('claims a legacy stream corroborated by a transcript without modifying the source', async () => {
    const original = serializeLegacyRows([
      makeLegacyRow('workflow@1'),
      makeLegacyRow('unrelated@2'),
    ]);
    await writeFile(filePath, original);

    const prepared = await prepareDesktopLegacyStreamImport(filePath, {
      transcriptStreamIds: ['workflow@1'],
    });

    expect(prepared.claims).toEqual(['workflow@1']);
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(writeFileAtomicMock).not.toHaveBeenCalled();
  });

  it('claims a stream with sidecar evidence alone', async () => {
    await writeFile(
      filePath,
      serializeLegacyRows([makeLegacyRow('sidecar@1')]),
    );

    const prepared = await prepareDesktopLegacyStreamImport(filePath, {
      sidecarStreamIds: ['sidecar@1'],
    });

    expect(prepared.claims).toEqual(['sidecar@1']);
  });

  it('removes only confirmed claims and preserves unmatched rows verbatim as data', async () => {
    const transcriptRow = makeLegacyRow('transcript@1', {
      metadata: { source: 'transcript' },
    });
    const sidecarRow = makeLegacyRow('sidecar@2', {
      config: { source: 'sidecar' },
    });
    const unmatchedRow = makeLegacyRow('other-workspace@3', {
      extensionField: ['preserve', 1],
    });
    await writeFile(
      filePath,
      serializeLegacyRows([transcriptRow, sidecarRow, unmatchedRow]),
    );
    const prepared = await prepareDesktopLegacyStreamImport(filePath, {
      transcriptStreamIds: ['transcript@1'],
      sidecarStreamIds: ['sidecar@2'],
    });

    await prepared.commit(['transcript@1', 'other-workspace@3']);

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      restoredStreams: { streams: LegacyRow[] };
    };
    expect(persisted.restoredStreams.streams).toEqual([
      sidecarRow,
      unmatchedRow,
    ]);
  });

  it('deletes the legacy file after all rows are successfully migrated', async () => {
    await writeFile(
      filePath,
      serializeLegacyRows([makeLegacyRow('workflow@1')]),
    );
    const prepared = await prepareDesktopLegacyStreamImport(filePath, {
      transcriptStreamIds: ['workflow@1'],
    });

    await prepared.commit(['workflow@1']);

    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(writeFileAtomicMock).not.toHaveBeenCalled();
  });

  it('retains recoverable legacy rows when an atomic rewrite fails', async () => {
    const migratedRow = makeLegacyRow('workflow@1');
    const unmatchedRow = makeLegacyRow('other-workspace@2');
    const original = serializeLegacyRows([migratedRow, unmatchedRow]);
    await writeFile(filePath, original);
    const prepared = await prepareDesktopLegacyStreamImport(filePath, {
      transcriptStreamIds: ['workflow@1'],
    });
    writeFileAtomicMock.mockRejectedValueOnce(new Error('disk full'));

    await expect(prepared.commit(['workflow@1'])).rejects.toThrow('disk full');
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(prepared.claims).toEqual(['workflow@1']);

    await prepared.commit(['workflow@1']);
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      restoredStreams: { streams: LegacyRow[] };
    };
    expect(persisted.restoredStreams.streams).toEqual([unmatchedRow]);
  });
});

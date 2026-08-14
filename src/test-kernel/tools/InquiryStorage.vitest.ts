import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as logUtils from '@logger/logUtils';
import { platform } from '@platform/platform';
import {
  ExternalInquiryPermissionSchema,
  ToolError,
  type InquiryThreadId,
  type StreamTabId,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  getOpenTurnDraft,
  listThreadsByStatus,
  markDropped,
  manifestToTranscript,
  persistOpenTurnDraft,
  readExternalInquiryThread,
  recordAnswerForOpenTurn,
  recordOpenQuestion,
} from '@tools/inquiry/externalInquiryStorage';

const STREAM_A = 'stream:a' as StreamTabId;
const STREAM_B = 'stream:b' as StreamTabId;
const GENERATION_A = 'f9de9269-9198-4103-a248-6a3bd78bd4eb';

/**
 * Capture per-channel log lines. The storage module logs through a channel
 * trace that binds `logUtils.warn` at module init, so a `vi.spyOn` installed
 * inside a test can't intercept it — observe the output sink instead (same
 * pattern as ChannelTrace.vitest.ts).
 */
function captureLogLines(): string[] {
  const lines: string[] = [];
  logUtils.setOutputChannelFactory(() => ({
    appendLine(message: string) {
      lines.push(message);
    },
  }));
  return lines;
}

function threadDirFor(threadId: string): string {
  return path.join(
    platform().storage.getGlobalStoragePath(),
    'ei_threads',
    threadId,
  );
}

async function writeTextFile(target: string, text: string): Promise<void> {
  await platform().fs.writeFile(target, Buffer.from(text, 'utf8'));
}

async function readTextFile(target: string): Promise<string> {
  return Buffer.from(await platform().fs.readFile(target)).toString('utf8');
}

/**
 * Seed a manifest that must read as missing, then assert the read is null and
 * loud. Returns the manifest path so tests can also assert the on-disk file
 * is preserved byte-for-byte.
 */
async function expectUnreadableManifest(
  threadId: string,
  body: string,
  expectedLog: string,
): Promise<string> {
  const threadDir = threadDirFor(threadId);
  const manifestPath = path.join(threadDir, 'manifest.json');
  await platform().fs.createDirectory(threadDir);
  await writeTextFile(manifestPath, body);
  const logLines = captureLogLines();

  await expect(readExternalInquiryThread(threadId)).resolves.toBeNull();
  expect(logLines.join('\n')).toContain(expectedLog);
  return manifestPath;
}

describe('InquiryStorage', () => {
  // Each test seeds threads against a fresh platform: state must not leak
  // between tests in this file, so this installs (and resets) per test
  // rather than once for the whole file.
  setupPlatform();

  afterEach(() => {
    logUtils.setOutputChannelFactory(null);
  });

  it('treats a missing inquiry history directory as empty', async () => {
    await expect(
      listThreadsByStatus({ status: 'open', scope: 'all' }),
    ).resolves.toEqual([]);
  });

  it('surfaces inquiry history directory read failures', async () => {
    const threadsDir = path.join(
      platform().storage.getGlobalStoragePath(),
      'ei_threads',
    );
    const readDirectorySpy = vi
      .spyOn(platform().fs, 'readDirectory')
      .mockRejectedValueOnce(
        Object.assign(new Error('inquiry history is unreadable'), {
          code: 'EACCES',
        }),
      );

    try {
      await expect(
        listThreadsByStatus({ status: 'open', scope: 'all' }),
      ).rejects.toMatchObject({ code: 'EACCES' });
      expect(readDirectorySpy).toHaveBeenCalledWith(threadsDir);
    } finally {
      readDirectorySpy.mockRestore();
    }
  });

  it('opens, answers, and resolves a thread end-to-end', async () => {
    const opened = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      parentGenerationId: GENERATION_A,
      question: 'What is the Sobolev constant?',
      suggestSearch: false,
    });

    expect(opened.manifest.status).toBe('open');
    expect(opened.manifest.parentStreamId).toBe(STREAM_A);
    expect(opened.manifest.turns).toHaveLength(1);
    expect(opened.turn.parentGenerationId).toBe(GENERATION_A);
    expect(opened.turn.suggestSearch).toBe(false);

    const open = await listThreadsByStatus({ status: 'open', scope: 'all' });
    expect(open).toHaveLength(1);
    expect(open[0].status).toBe('open');

    const answered = await recordAnswerForOpenTurn({
      threadId: opened.threadId,
      answer: 'C = (n(n-2))^{-1} * ω_n^{2/n}',
    });
    expect(answered).not.toBeNull();
    expect(answered!.manifest.status).toBe('answered');
    expect(answered!.turn.parentGenerationId).toBe(GENERATION_A);
    expect(answered!.turn.answer).toBe('C = (n(n-2))^{-1} * ω_n^{2/n}');

    const stillOpen = await listThreadsByStatus({
      status: 'open',
      scope: 'all',
    });
    expect(stillOpen).toHaveLength(0);
  });

  it.each([
    {
      name: 'rejects re-dispatch on an open thread',
      retire: async (_threadId: InquiryThreadId) => {},
    },
    {
      name: 'rejects ask on a dropped thread',
      retire: async (threadId: InquiryThreadId) => {
        await markDropped({ threadId });
      },
    },
  ])('$name', async ({ retire }) => {
    const opened = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });
    await retire(opened.threadId);

    await expect(
      recordOpenQuestion({
        threadId: opened.threadId,
        parentStreamId: STREAM_A,
        question: 'Q2',
      }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('allows ask follow-up on an answered thread; status flips back to open', async () => {
    const t = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });
    await recordAnswerForOpenTurn({ threadId: t.threadId, answer: 'A1' });

    const followUp = await recordOpenQuestion({
      threadId: t.threadId,
      parentStreamId: STREAM_A,
      question: 'Q2 (follow-up)',
    });

    expect(followUp.manifest.status).toBe('open');
    expect(followUp.manifest.turns).toHaveLength(2);
    expect(followUp.turn.question).toBe('Q2 (follow-up)');
  });

  it('keeps first-turn draft context valid for hydrated new inquiries', async () => {
    const t = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });
    const draft = {
      answer: 'partial answer',
      sessionLinks: 'https://chat.example/thread',
    };
    await persistOpenTurnDraft({
      threadId: t.threadId,
      draft,
    });

    const manifest = await readExternalInquiryThread(t.threadId);
    expect(manifest).not.toBeNull();

    const permission = ExternalInquiryPermissionSchema.parse({
      requestId: t.threadId,
      threadId: t.threadId,
      question: 'Q1',
      allowBypass: false,
      streamId: STREAM_A,
      mode: 'new',
      sessionLinks: undefined,
      draft: getOpenTurnDraft(manifest!),
      transcript: manifestToTranscript(manifest!),
    });

    expect(permission).toMatchObject({
      mode: 'new',
      draft,
      transcript: [{ turnIndex: 1, question: 'Q1', answer: undefined }],
    });
  });

  it('persists open-turn drafts and exposes transcript turns', async () => {
    const t = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });
    await recordAnswerForOpenTurn({ threadId: t.threadId, answer: 'A1' });
    await recordOpenQuestion({
      threadId: t.threadId,
      parentStreamId: STREAM_A,
      question: 'Q2',
    });

    await persistOpenTurnDraft({
      threadId: t.threadId,
      draft: {
        answer: 'partial answer',
        sessionLinks: 'https://chat.example/thread',
      },
    });

    const manifest = await readExternalInquiryThread(t.threadId);
    expect(manifest).not.toBeNull();
    expect(getOpenTurnDraft(manifest!)).toEqual({
      answer: 'partial answer',
      sessionLinks: 'https://chat.example/thread',
    });
    expect(manifestToTranscript(manifest!)).toMatchObject([
      { turnIndex: 1, question: 'Q1', answer: 'A1' },
      { turnIndex: 2, question: 'Q2', answer: undefined },
    ]);
  });

  it('updates parentStreamId on cross-stream follow-up', async () => {
    const t = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });
    await recordAnswerForOpenTurn({ threadId: t.threadId, answer: 'A1' });

    const fromB = await recordOpenQuestion({
      threadId: t.threadId,
      parentStreamId: STREAM_B,
      question: 'Q2 from B',
    });
    expect(fromB.manifest.parentStreamId).toBe(STREAM_B);

    const openOnA = await listThreadsByStatus({
      status: 'open',
      scope: 'stream',
      streamId: STREAM_A,
    });
    const openOnB = await listThreadsByStatus({
      status: 'open',
      scope: 'stream',
      streamId: STREAM_B,
    });
    expect(openOnA).toHaveLength(0);
    expect(openOnB).toHaveLength(1);
  });

  it('listThreadsByStatus filters by status and scope', async () => {
    const t1 = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });
    await recordAnswerForOpenTurn({ threadId: t1.threadId, answer: 'A1' });

    const t2 = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q2',
    });

    const t3 = await recordOpenQuestion({
      parentStreamId: STREAM_B,
      question: 'Q3',
    });
    await markDropped({ threadId: t3.threadId });

    const openOnA = await listThreadsByStatus({
      status: 'open',
      scope: 'stream',
      streamId: STREAM_A,
    });
    expect(openOnA.map((t) => t.threadId)).toEqual([t2.threadId]);

    const allDropped = await listThreadsByStatus({
      status: 'dropped',
      scope: 'all',
    });
    expect(allDropped.map((t) => t.threadId)).toEqual([t3.threadId]);

    const answered = await listThreadsByStatus({
      status: 'answered',
      scope: 'all',
    });
    expect(answered.map((t) => t.threadId)).toEqual([t1.threadId]);
  });

  it('stamps schemaVersion on newly written manifests', async () => {
    const t = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });

    const manifestPath = path.join(threadDirFor(t.threadId), 'manifest.json');
    const persisted = JSON.parse(await readTextFile(manifestPath)) as {
      schemaVersion?: number;
    };
    expect(persisted.schemaVersion).toBe(1);
  });

  it('treats a corrupt manifest as missing (loud read) without clobbering it', async () => {
    const manifestPath = await expectUnreadableManifest(
      'ei_aabbccdd0033',
      '{ not valid json',
      'Unreadable external-inquiry manifest for ei_aabbccdd0033',
    );

    // A follow-up dispatch addressed at the corrupt thread reports
    // not-found instead of silently overwriting the on-disk file.
    await expect(
      recordOpenQuestion({
        threadId: 'ei_aabbccdd0033' as InquiryThreadId,
        parentStreamId: STREAM_A,
        question: 'Q?',
      }),
    ).rejects.toBeInstanceOf(ToolError);
    expect(await readTextFile(manifestPath)).toBe('{ not valid json');
  });

  it('treats a schema-invalid manifest as missing (loud read)', async () => {
    await expectUnreadableManifest(
      'ei_aabbccdd0044',
      JSON.stringify({ threadId: 42, turns: 'nope' }),
      'Failed to parse external-inquiry manifest for ei_aabbccdd0044',
    );
  });

  it('treats an unknown schemaVersion as unreadable, never as legacy data', async () => {
    // Legacy-shaped body stamped with a future version: without the version
    // gate this would fail the canonical arm and silently parse as a legacy
    // thread (status rewritten to 'answered', parentStreamId to null).
    const futureManifest = JSON.stringify({
      schemaVersion: 2,
      threadId: 'ei_aabbccdd0055',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      turns: [
        {
          turnIndex: 1,
          timestamp: '2025-01-01T00:00:00.000Z',
          question: 'Future Q',
          questionRelativePath: 't1/question.txt',
          answerRelativePath: 't1/answer.txt',
        },
      ],
    });

    const manifestPath = await expectUnreadableManifest(
      'ei_aabbccdd0055',
      futureManifest,
      'Unsupported external-inquiry manifest schemaVersion 2 for ei_aabbccdd0055',
    );

    // The on-disk file is preserved byte-for-byte for the newer writer.
    expect(await readTextFile(manifestPath)).toBe(futureManifest);
  });

  it('rejects an unversioned manifest without rewriting it', async () => {
    const unversionedManifest = JSON.stringify({
      threadId: 'ei_aabbccdd0066',
      parentStreamId: STREAM_A,
      status: 'open',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      turns: [],
    });

    const manifestPath = await expectUnreadableManifest(
      'ei_aabbccdd0066',
      unversionedManifest,
      'Failed to parse external-inquiry manifest for ei_aabbccdd0066',
    );
    expect(await readTextFile(manifestPath)).toBe(unversionedManifest);
  });

  it('rejects a version-stamped manifest whose canonical shape is invalid', async () => {
    // schemaVersion present (current) but `status`/`parentStreamId` missing:
    // the canonical schema rejects it.
    await expectUnreadableManifest(
      'ei_aabbccdd0077',
      JSON.stringify({
        schemaVersion: 1,
        threadId: 'ei_aabbccdd0077',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-02T00:00:00.000Z',
        turns: [],
      }),
      'Failed to parse external-inquiry manifest for ei_aabbccdd0077',
    );
  });

  it.each([
    { label: 'null', value: null },
    { label: 'a non-UUID string', value: 'generation-a' },
  ])('rejects $label inquiry generation as corrupt', async ({ value }) => {
    await expectUnreadableManifest(
      'ei_aabbccdd0088',
      JSON.stringify({
        schemaVersion: 1,
        threadId: 'ei_aabbccdd0088',
        parentStreamId: STREAM_A,
        status: 'open',
        createdAt: '2026-08-13T12:00:00.000Z',
        updatedAt: '2026-08-13T12:00:00.000Z',
        turns: [
          {
            kind: 'open',
            turnIndex: 1,
            timestamp: '2026-08-13T12:00:00.000Z',
            parentGenerationId: value,
            question: 'Is the estimate uniform?',
            questionRelativePath: 't1/question.txt',
          },
        ],
      }),
      'Failed to parse external-inquiry manifest for ei_aabbccdd0088',
    );
  });
});

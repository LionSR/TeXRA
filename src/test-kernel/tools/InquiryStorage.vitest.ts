/**
 * Vitests for the inquiry storage layer: open → answer round-trip,
 * dropped path, follow-up turn semantics, legacy manifest migration,
 * and listing filters.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as logUtils from '@logger/logUtils';
import {
  ExternalInquiryPermissionSchema,
  type ExternalInquiryThreadId,
  type StreamTabId,
} from '@shared/schemas';
import { ToolError } from '@shared/schemas/toolResult';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  getOpenTurnDraft,
  listOpenThreads,
  listOpenThreadsForStream,
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

describe('InquiryStorage', () => {
  // Each test seeds threads against a fresh platform: state must not leak
  // between tests in this file, so this installs (and resets) per test
  // rather than once for the whole file.
  setupPlatform();

  afterEach(() => {
    logUtils.setOutputChannelFactory(null);
  });

  it('treats a missing inquiry history directory as empty', async () => {
    await expect(listOpenThreads()).resolves.toEqual([]);
  });

  it('surfaces inquiry history directory read failures', async () => {
    const platform = (await import('@platform/platform')).platform();
    const threadsDir = `${platform.storage.getGlobalStoragePath()}/ei_threads`;
    const readDirectorySpy = vi
      .spyOn(platform.fs, 'readDirectory')
      .mockRejectedValueOnce(
        Object.assign(new Error('inquiry history is unreadable'), {
          code: 'EACCES',
        }),
      );

    try {
      await expect(listOpenThreads()).rejects.toMatchObject({ code: 'EACCES' });
      expect(readDirectorySpy).toHaveBeenCalledWith(threadsDir);
    } finally {
      readDirectorySpy.mockRestore();
    }
  });

  it('opens, answers, and resolves a thread end-to-end', async () => {
    const opened = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'What is the Sobolev constant?',
      suggestSearch: false,
    });

    expect(opened.manifest.status).toBe('open');
    expect(opened.manifest.parentStreamId).toBe(STREAM_A);
    expect(opened.manifest.turns).toHaveLength(1);
    expect(opened.turn.suggestSearch).toBe(false);

    const open = await listOpenThreads();
    expect(open).toHaveLength(1);
    expect(open[0].status).toBe('open');

    const answered = await recordAnswerForOpenTurn({
      threadId: opened.threadId,
      answer: 'C = (n(n-2))^{-1} * ω_n^{2/n}',
    });
    expect(answered).not.toBeNull();
    expect(answered!.manifest.status).toBe('answered');
    expect(answered!.turn.answer).toBe('C = (n(n-2))^{-1} * ω_n^{2/n}');

    const stillOpen = await listOpenThreads();
    expect(stillOpen).toHaveLength(0);
  });

  it('rejects re-dispatch on an open thread', async () => {
    const opened = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });

    await expect(
      recordOpenQuestion({
        threadId: opened.threadId,
        parentStreamId: STREAM_A,
        question: 'Q2',
      }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('rejects ask on a dropped thread', async () => {
    const opened = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });
    await markDropped({ threadId: opened.threadId });

    await expect(
      recordOpenQuestion({
        threadId: opened.threadId,
        parentStreamId: STREAM_A,
        question: 'Follow-up',
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

    const openOnA = await listOpenThreadsForStream(STREAM_A);
    const openOnB = await listOpenThreadsForStream(STREAM_B);
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

  it('parses a legacy manifest (no status/parentStreamId) as answered with null parent', async () => {
    const platform = (await import('@platform/platform')).platform();
    const threadDir = `${platform.storage.getGlobalStoragePath()}/ei_threads/ei_aabbccdd0011`;
    // Legacy manifest shape — pre-async storage.
    const legacy = {
      threadId: 'ei_aabbccdd0011',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      turns: [
        {
          turnIndex: 1,
          timestamp: '2025-01-01T00:00:00.000Z',
          question: 'Legacy Q',
          questionRelativePath: 't1/question.txt',
          answerRelativePath: 't1/answer.txt',
        },
      ],
    };
    await platform.fs.createDirectory(threadDir);
    await platform.fs.createDirectory(`${threadDir}/t1`);
    await platform.fs.writeFile(
      `${threadDir}/t1/answer.txt`,
      Buffer.from('Legacy A', 'utf8'),
    );
    await platform.fs.writeFile(
      `${threadDir}/manifest.json`,
      Buffer.from(JSON.stringify(legacy), 'utf8'),
    );

    const manifest = await readExternalInquiryThread('ei_aabbccdd0011');
    expect(manifest).not.toBeNull();
    expect(manifest!.status).toBe('answered');
    expect(manifest!.parentStreamId).toBeNull();
    expect(manifestToTranscript(manifest!)).toMatchObject([
      { turnIndex: 1, question: 'Legacy Q', answer: 'Legacy A' },
    ]);

    const persisted = JSON.parse(
      Buffer.from(
        await platform.fs.readFile(`${threadDir}/manifest.json`),
      ).toString('utf8'),
    ) as { turns: Array<{ answer?: string }> };
    expect(persisted.turns[0]?.answer).toBe('Legacy A');
  });

  it('stamps schemaVersion on newly written manifests', async () => {
    const t = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });

    const platform = (await import('@platform/platform')).platform();
    const manifestPath = `${platform.storage.getGlobalStoragePath()}/ei_threads/${t.threadId}/manifest.json`;
    const persisted = JSON.parse(
      Buffer.from(await platform.fs.readFile(manifestPath)).toString('utf8'),
    ) as { schemaVersion?: number };
    expect(persisted.schemaVersion).toBe(1);
  });

  it('treats a corrupt manifest as missing (loud read) without clobbering it', async () => {
    const platform = (await import('@platform/platform')).platform();
    const threadDir = `${platform.storage.getGlobalStoragePath()}/ei_threads/ei_aabbccdd0033`;
    const manifestPath = `${threadDir}/manifest.json`;
    await platform.fs.createDirectory(threadDir);
    await platform.fs.writeFile(
      manifestPath,
      Buffer.from('{ not valid json', 'utf8'),
    );
    const logLines = captureLogLines();

    await expect(
      readExternalInquiryThread('ei_aabbccdd0033'),
    ).resolves.toBeNull();
    expect(logLines.join('\n')).toContain(
      'Unreadable external-inquiry manifest for ei_aabbccdd0033',
    );

    // A follow-up dispatch addressed at the corrupt thread reports
    // not-found instead of silently overwriting the on-disk file.
    await expect(
      recordOpenQuestion({
        threadId: 'ei_aabbccdd0033' as ExternalInquiryThreadId,
        parentStreamId: STREAM_A,
        question: 'Q?',
      }),
    ).rejects.toBeInstanceOf(ToolError);
    const stillOnDisk = Buffer.from(
      await platform.fs.readFile(manifestPath),
    ).toString('utf8');
    expect(stillOnDisk).toBe('{ not valid json');
  });

  it('treats a schema-invalid manifest as missing (loud read)', async () => {
    const platform = (await import('@platform/platform')).platform();
    const threadDir = `${platform.storage.getGlobalStoragePath()}/ei_threads/ei_aabbccdd0044`;
    await platform.fs.createDirectory(threadDir);
    await platform.fs.writeFile(
      `${threadDir}/manifest.json`,
      Buffer.from(JSON.stringify({ threadId: 42, turns: 'nope' }), 'utf8'),
    );
    const logLines = captureLogLines();

    await expect(
      readExternalInquiryThread('ei_aabbccdd0044'),
    ).resolves.toBeNull();
    expect(logLines.join('\n')).toContain(
      'Failed to parse external-inquiry manifest for ei_aabbccdd0044',
    );
  });

  it('treats an unknown schemaVersion as unreadable, never as legacy data', async () => {
    const platform = (await import('@platform/platform')).platform();
    const threadDir = `${platform.storage.getGlobalStoragePath()}/ei_threads/ei_aabbccdd0055`;
    const manifestPath = `${threadDir}/manifest.json`;
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
    await platform.fs.createDirectory(threadDir);
    await platform.fs.writeFile(
      manifestPath,
      Buffer.from(futureManifest, 'utf8'),
    );
    const logLines = captureLogLines();

    await expect(
      readExternalInquiryThread('ei_aabbccdd0055'),
    ).resolves.toBeNull();
    expect(logLines.join('\n')).toContain(
      'Unsupported external-inquiry manifest schemaVersion 2 for ei_aabbccdd0055',
    );

    // The on-disk file is preserved byte-for-byte for the newer writer.
    const stillOnDisk = Buffer.from(
      await platform.fs.readFile(manifestPath),
    ).toString('utf8');
    expect(stillOnDisk).toBe(futureManifest);
  });

  it('never legacy-parses a version-stamped manifest whose canonical shape is invalid', async () => {
    const platform = (await import('@platform/platform')).platform();
    const threadDir = `${platform.storage.getGlobalStoragePath()}/ei_threads/ei_aabbccdd0077`;
    // schemaVersion present (current) but `status`/`parentStreamId` missing:
    // the canonical arm rejects it, and the legacy arm must too — legacy is
    // reserved for version-ABSENT manifests.
    await platform.fs.createDirectory(threadDir);
    await platform.fs.writeFile(
      `${threadDir}/manifest.json`,
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          threadId: 'ei_aabbccdd0077',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-02T00:00:00.000Z',
          turns: [],
        }),
        'utf8',
      ),
    );
    const logLines = captureLogLines();

    await expect(
      readExternalInquiryThread('ei_aabbccdd0077'),
    ).resolves.toBeNull();
    expect(logLines.join('\n')).toContain(
      'Failed to parse external-inquiry manifest for ei_aabbccdd0077',
    );
  });

  it('returns a hydrated legacy manifest when write-back fails', async () => {
    const platform = (await import('@platform/platform')).platform();
    const threadDir = `${platform.storage.getGlobalStoragePath()}/ei_threads/ei_aabbccdd0022`;
    const manifestPath = `${threadDir}/manifest.json`;
    const legacy = {
      threadId: 'ei_aabbccdd0022',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      turns: [
        {
          turnIndex: 1,
          timestamp: '2025-01-01T00:00:00.000Z',
          question: 'Legacy Q',
          questionRelativePath: 't1/question.txt',
          answerRelativePath: 't1/answer.txt',
        },
      ],
    };
    await platform.fs.createDirectory(threadDir);
    await platform.fs.createDirectory(`${threadDir}/t1`);
    await platform.fs.writeFile(
      `${threadDir}/t1/answer.txt`,
      Buffer.from('Legacy A', 'utf8'),
    );
    await platform.fs.writeFile(
      manifestPath,
      Buffer.from(JSON.stringify(legacy), 'utf8'),
    );
    const originalWriteFileAtomic = platform.fs.writeFileAtomic.bind(
      platform.fs,
    );
    const writeFileAtomicSpy = vi
      .spyOn(platform.fs, 'writeFileAtomic')
      .mockImplementation(async (target, content) => {
        if (target === manifestPath) {
          throw new Error('metadata disk full');
        }
        await originalWriteFileAtomic(target, content);
      });

    try {
      const manifest = await readExternalInquiryThread('ei_aabbccdd0022');
      expect(manifest).not.toBeNull();
      expect(manifestToTranscript(manifest!)).toMatchObject([
        { turnIndex: 1, question: 'Legacy Q', answer: 'Legacy A' },
      ]);
      expect(writeFileAtomicSpy).toHaveBeenCalledWith(
        manifestPath,
        expect.any(Uint8Array),
      );
    } finally {
      writeFileAtomicSpy.mockRestore();
    }

    const persisted = JSON.parse(
      Buffer.from(await platform.fs.readFile(manifestPath)).toString('utf8'),
    ) as { turns: Array<{ answer?: string }> };
    expect(persisted.turns[0]?.answer).toBeUndefined();
  });
});

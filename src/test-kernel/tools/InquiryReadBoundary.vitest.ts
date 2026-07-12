// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendFollowUpMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    status: 'sent' as const,
  })),
);
const wakeQueuedFollowUpStreamMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    kind: 'not_required' as const,
  })),
);

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  sendFollowUp: sendFollowUpMock,
  wakeQueuedFollowUpStream: wakeQueuedFollowUpStreamMock,
}));

import { setupPlatform } from '@test/support/setupPlatform';
import { hydrateOpenInquiryPermissions } from '@controllers/progressView/backend/externalInquiryHydration';
import {
  type ExternalInquiryPermission,
  type ExternalInquiryThreadId,
  type StreamTabId,
} from '@shared/schemas';
import { ExternalInquiryTool } from '@tools/inquiry/ExternalInquiryTool';
import { injectContinuationForAnsweredThread } from '@tools/inquiry/inquiryContinuation';

const THREAD = 'ei_aabbccdd0011' as ExternalInquiryThreadId;
const OPEN_THREAD = 'ei_aabbccdd0022' as ExternalInquiryThreadId;
const STREAM = 'stream:inquiry-read-boundary' as StreamTabId;

async function seedThread(
  threadId: ExternalInquiryThreadId,
  manifest: Record<string, unknown>,
  answers: Record<string, string>,
): Promise<void> {
  const { platform } = await import('@platform/platform');
  const storage = platform().storage.getGlobalStoragePath();
  const threadDir = `${storage}/ei_threads/${threadId}`;
  await platform().fs.createDirectory(threadDir);

  for (const [relativePath, content] of Object.entries(answers)) {
    const segments = relativePath.split('/');
    const filename = segments.pop();
    if (!filename) continue;
    let current = threadDir;
    for (const segment of segments) {
      current = `${current}/${segment}`;
      await platform().fs.createDirectory(current);
    }
    await platform().fs.writeFile(
      `${current}/${filename}`,
      Buffer.from(content, 'utf8'),
    );
  }

  await platform().fs.writeFile(
    `${threadDir}/manifest.json`,
    Buffer.from(JSON.stringify(manifest), 'utf8'),
  );
}

function answeredLegacyManifest(
  threadId: ExternalInquiryThreadId = THREAD,
): Record<string, unknown> {
  return {
    threadId,
    parentStreamId: STREAM,
    status: 'answered',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    turns: [
      {
        turnIndex: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        question: 'Legacy Q',
        questionRelativePath: 't1/question.txt',
        answerRelativePath: 't1/answer.txt',
      },
    ],
  };
}

function openFollowUpLegacyManifest(): Record<string, unknown> {
  return {
    threadId: OPEN_THREAD,
    parentStreamId: STREAM,
    status: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:02:00.000Z',
    turns: [
      {
        turnIndex: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        question: 'Legacy Q',
        questionRelativePath: 't1/question.txt',
        answerRelativePath: 't1/answer.txt',
      },
      {
        turnIndex: 2,
        timestamp: '2026-01-01T00:02:00.000Z',
        question: 'Follow-up Q',
        questionRelativePath: 't2/question.txt',
      },
    ],
  };
}

function createProgressProviderShell(): {
  hydrate: () => Promise<void>;
  show: ReturnType<typeof vi.fn>;
} {
  const show = vi.fn<(permission: ExternalInquiryPermission) => void>();
  return {
    hydrate: () =>
      hydrateOpenInquiryPermissions({
        webviewUpdater: {
          isAvailable: () => true,
          syncInquiryThreads: vi.fn(),
        },
        externalInquiry: {
          pendingSize: 0,
          show,
        },
        logger: { debug: vi.fn() },
      }),
    show,
  };
}

function createHydrationShellWithPendingInquiry(): {
  hydrate: () => Promise<void>;
  show: ReturnType<typeof vi.fn>;
} {
  const show = vi.fn<(permission: ExternalInquiryPermission) => void>();
  return {
    hydrate: () =>
      hydrateOpenInquiryPermissions({
        webviewUpdater: {
          isAvailable: () => true,
          syncInquiryThreads: vi.fn(),
        },
        externalInquiry: {
          pendingSize: 1,
          show,
        },
        logger: { debug: vi.fn() },
      }),
    show,
  };
}

describe('external inquiry read boundary', () => {
  // Tests seed threads against a fresh platform: state must not leak between
  // tests in this file, so this installs (and resets) per test rather than
  // once for the whole file.
  setupPlatform();

  beforeEach(() => {
    sendFollowUpMock.mockClear();
    wakeQueuedFollowUpStreamMock.mockClear();
  });

  it('hydrates legacy answers through inquiry read', async () => {
    await seedThread(THREAD, answeredLegacyManifest(), {
      't1/answer.txt': 'Legacy A',
    });

    const result = await new ExternalInquiryTool().call({
      command: 'read',
      thread_id: THREAD,
    });

    expect(result.output).toContain('Legacy A');
    expect(result.output).not.toContain('(awaiting user answer)');
  });

  it('hydrates legacy answers through continuation injection', async () => {
    await seedThread(THREAD, answeredLegacyManifest(), {
      't1/answer.txt': 'Legacy A',
    });

    const outcome = await injectContinuationForAnsweredThread(THREAD);

    expect(outcome).toBe('sent');
    expect(sendFollowUpMock).toHaveBeenCalledWith(
      STREAM,
      expect.stringContaining('Legacy A'),
      undefined,
      undefined,
      undefined,
    );
  });

  it('hydrates legacy answers through progress-view inquiry hydration', async () => {
    await seedThread(OPEN_THREAD, openFollowUpLegacyManifest(), {
      't1/answer.txt': 'Legacy A',
    });
    const { hydrate, show } = createProgressProviderShell();

    await hydrate();

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'followUp',
        threadId: OPEN_THREAD,
        question: 'Follow-up Q',
        transcript: expect.arrayContaining([
          expect.objectContaining({ question: 'Legacy Q', answer: 'Legacy A' }),
        ]),
      }),
    );
  });

  it('does not rehydrate durable inquiries when pending state is already warm', async () => {
    await seedThread(OPEN_THREAD, openFollowUpLegacyManifest(), {
      't1/answer.txt': 'Legacy A',
    });
    const { hydrate, show } = createHydrationShellWithPendingInquiry();

    await hydrate();

    expect(show).not.toHaveBeenCalled();
  });
});

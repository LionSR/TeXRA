import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamTabId } from '@shared/schemas';
import { waitForCondition } from '@test/support/asyncTestUtils';
import type * as VSCode from 'vscode';

const mocks = vi.hoisted(() => ({
  diagnosticCollections: [] as Array<{
    readonly items: Map<string, unknown[]>;
    clear: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  registeredProviders: [] as unknown[],
  registerFileDecorationProvider: vi.fn((provider: unknown) => {
    mocks.registeredProviders.push(provider);
    return { dispose: vi.fn() };
  }),
  createDiagnosticCollection: vi.fn(() => {
    const items = new Map<string, unknown[]>();
    const collection = {
      items,
      get: (uri: { fsPath: string }) => items.get(uri.fsPath),
      set: (uri: { fsPath: string }, diagnostics: unknown[]) => {
        items.set(uri.fsPath, diagnostics);
      },
      delete: (uri: { fsPath: string }) => {
        items.delete(uri.fsPath);
      },
      clear: vi.fn(() => items.clear()),
      dispose: vi.fn(),
    };
    mocks.diagnosticCollections.push(collection);
    return collection;
  }),
}));

vi.mock('vscode', () => {
  class Diagnostic {
    source: string | undefined;
    code: string | undefined;

    constructor(
      public range: unknown,
      public message: string,
      public severity: number,
    ) {}
  }

  class EventEmitter<T> {
    event = (_listener: (e: T) => unknown) => ({ dispose: vi.fn() });
    fire(_data: T): void {}
    dispose(): void {}
  }

  return {
    Diagnostic,
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3,
    },
    EventEmitter,
    Range: class {
      constructor(
        public startLine: number,
        public startCharacter: number,
        public endLine: number,
        public endCharacter: number,
      ) {}
    },
    ThemeColor: class {
      constructor(public id: string) {}
    },
    Uri: {
      file: (absolutePath: string) => ({
        scheme: 'file',
        fsPath: absolutePath,
        path: absolutePath,
        toString: () => absolutePath,
      }),
    },
    languages: {
      createDiagnosticCollection: mocks.createDiagnosticCollection,
    },
    window: {
      createOutputChannel: (_name: string) => ({
        appendLine: (_text: string) => {},
        append: (_text: string) => {},
        show: () => {},
        dispose: () => {},
      }),
      registerFileDecorationProvider: mocks.registerFileDecorationProvider,
    },
    workspace: {
      getConfiguration: (_section?: string) => ({
        get: <T>(_key: string, defaultValue?: T) => defaultValue,
      }),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
  };
});

const { SessionEventHub } = await import('@agent/runtime/SessionEventHub');
const { appSignals } = await import('@eventBus/AppSignals');
const { registerInlineCriticism, setInlineCriticismEnabled } =
  await import('@frontend/latex/inlineCriticism');
const { registerFileDecorations } =
  await import('@frontend/ui/fileDecorations');
const { AbsoluteFS } = await import('@utils/files/absoluteFS');
const vscode = await import('vscode');

const streamId = 'stream:frontend-run-fact' as StreamTabId;

function emitOutputFiles(
  hub: InstanceType<typeof SessionEventHub>,
  absolutePath: string,
): void {
  hub.emit({
    scope: 'run',
    streamId,
    event: {
      type: 'addOutputFiles',
      streamId,
      filesByRound: {
        1: [
          {
            source: absolutePath,
            location: {
              kind: 'workspace',
              absolutePath,
              relativePath: absolutePath.split('/').at(-1) ?? absolutePath,
            },
            lineage: null,
            diff: null,
            round: 1,
          },
        ],
      },
    },
  });
}

/** Diagnostics currently recorded for `absolutePath` in the latest collection. */
function latestDiagnostics(absolutePath: string): unknown[] | undefined {
  return mocks.diagnosticCollections.at(-1)?.items.get(absolutePath);
}

function disposeContext(context: {
  subscriptions: Array<{ dispose(): unknown }>;
}) {
  for (const subscription of context.subscriptions.toReversed()) {
    subscription.dispose();
  }
}

describe('output-file run fact frontend subscriptions', () => {
  let tempDir: string | undefined;

  beforeEach(() => {
    mocks.diagnosticCollections.length = 0;
    mocks.registeredProviders.length = 0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (tempDir) {
      await AbsoluteFS.delete(tempDir, { recursive: true });
      tempDir = undefined;
    }
  });

  it('badges run-fact output files and app-scoped workspace writes', () => {
    const hub = new SessionEventHub();
    const context = { subscriptions: [] };
    registerFileDecorations(context as unknown as VSCode.ExtensionContext, hub);
    const provider = mocks.registeredProviders.at(-1) as {
      provideFileDecoration(uri: { scheme: string; fsPath: string }): unknown;
    };
    const texraBadge = { badge: 'T', tooltip: 'Modified by TeXRA' };

    const runFactPath = '/tmp/texra-run-fact-output.tex';
    emitOutputFiles(hub, runFactPath);
    expect(
      provider.provideFileDecoration(vscode.Uri.file(runFactPath)),
    ).toMatchObject(texraBadge);

    const writtenPath = '/tmp/texra-workspace-written.tex';
    appSignals.emit('workspaceFilesWritten', {
      absolutePaths: [writtenPath],
    });
    expect(
      provider.provideFileDecoration(vscode.Uri.file(writtenPath)),
    ).toMatchObject(texraBadge);

    disposeContext(context);
    expect(
      provider.provideFileDecoration(vscode.Uri.file(writtenPath)),
    ).toBeUndefined();
  });

  it('refreshes inline criticism only for live run facts while enabled', async () => {
    tempDir = `/tmp/texra-inline-criticism-${Date.now()}`;
    const outputPath = join(tempDir, 'out.tex');
    await AbsoluteFS.createDir(tempDir);
    await AbsoluteFS.write(
      outputPath,
      'before\n\\criticize{tighten this argument}{4}{5}\nafter\n',
    );

    const hub = new SessionEventHub();
    const context = { subscriptions: [] };
    registerInlineCriticism(context as unknown as VSCode.ExtensionContext, hub);

    emitOutputFiles(hub, outputPath);
    await setInlineCriticismEnabled(true);
    expect(latestDiagnostics(outputPath)).toBe(undefined);

    emitOutputFiles(hub, outputPath);
    await waitForCondition(
      () => (latestDiagnostics(outputPath) ?? []).length > 0,
      {
        timeoutMs: 200,
        timeoutMessage: 'inline criticism diagnostics were not refreshed',
      },
    );
    expect(latestDiagnostics(outputPath)).toHaveLength(1);

    await setInlineCriticismEnabled(false);
    emitOutputFiles(hub, outputPath);
    expect(latestDiagnostics(outputPath)).toBe(undefined);

    disposeContext(context);
  });
});

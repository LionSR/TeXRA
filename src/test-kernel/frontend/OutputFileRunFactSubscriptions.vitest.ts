import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { OutputFileInfo, StreamTabId } from '@shared/schemas';
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
    Disposable: class {
      constructor(private readonly callOnDispose: () => unknown) {}
      dispose(): void {
        this.callOnDispose();
      }
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
const { toRunFactDomainKey } = await import('@agent/runtime/runFactEvents');
const { appSignals } = await import('@eventBus/AppSignals');
const { ProgressEventBus } = await import('@eventBus/ProgressEventBus');
const { registerInlineCriticism, setInlineCriticismEnabled } =
  await import('@frontend/latex/inlineCriticism');
const { registerFileDecorations } =
  await import('@frontend/ui/fileDecorations');
const { AbsoluteFS } = await import('@utils/files');
const vscode = await import('vscode');

const streamId = 'stream:frontend-run-fact' as StreamTabId;

function makeContext(): {
  subscriptions: Array<{ dispose(): unknown }>;
} {
  return { subscriptions: [] };
}

function workspaceOutputFile(absolutePath: string): OutputFileInfo {
  return {
    source: absolutePath,
    location: {
      kind: 'workspace',
      absolutePath,
      relativePath: absolutePath.split('/').at(-1) ?? absolutePath,
    },
    lineage: null,
    diff: null,
    round: 1,
  };
}

function addOutputFilesPayload(
  absolutePath: string,
): ProgressEventPayloads['addOutputFiles'] {
  return {
    streamId,
    filesByRound: { 1: [workspaceOutputFile(absolutePath)] },
  };
}

function emitAddOutputFilesRunFact(
  hub: InstanceType<typeof SessionEventHub>,
  payload: ProgressEventPayloads['addOutputFiles'],
): void {
  hub.emit({
    scope: 'run',
    streamId,
    event: {
      type: 'domain',
      key: toRunFactDomainKey('addOutputFiles'),
      data: payload,
    },
  });
}

function disposeContext(context: {
  subscriptions: Array<{ dispose(): unknown }>;
}) {
  for (const subscription of context.subscriptions.toReversed()) {
    subscription.dispose();
  }
}

function drainBufferedAddOutputFilesBusEvents(): void {
  const unsubscribe = ProgressEventBus.on('addOutputFiles', () => undefined);
  unsubscribe();
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(message);
}

describe('output-file run fact frontend subscriptions', () => {
  let tempDir: string | undefined;

  beforeEach(() => {
    mocks.diagnosticCollections.length = 0;
    mocks.registeredProviders.length = 0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    drainBufferedAddOutputFilesBusEvents();
    if (tempDir) {
      await AbsoluteFS.delete(tempDir, { recursive: true });
      tempDir = undefined;
    }
  });

  it('badges run-fact output files and app-scoped workspace writes', () => {
    const hub = new SessionEventHub();
    const context = makeContext();
    registerFileDecorations(context as unknown as VSCode.ExtensionContext, hub);
    const provider = mocks.registeredProviders.at(-1) as {
      provideFileDecoration(uri: { scheme: string; fsPath: string }): unknown;
    };

    const legacyPath = '/tmp/texra-legacy-output.tex';
    ProgressEventBus.emit('addOutputFiles', addOutputFilesPayload(legacyPath));
    expect(provider.provideFileDecoration(vscode.Uri.file(legacyPath))).toBe(
      undefined,
    );
    drainBufferedAddOutputFilesBusEvents();

    const runFactPath = '/tmp/texra-run-fact-output.tex';
    emitAddOutputFilesRunFact(hub, addOutputFilesPayload(runFactPath));
    expect(
      provider.provideFileDecoration(vscode.Uri.file(runFactPath)),
    ).toMatchObject({ badge: 'T', tooltip: 'Modified by TeXRA' });

    const writtenPath = '/tmp/texra-workspace-written.tex';
    appSignals.emit('workspaceFilesWritten', {
      absolutePaths: [writtenPath],
    });
    expect(
      provider.provideFileDecoration(vscode.Uri.file(writtenPath)),
    ).toMatchObject({ badge: 'T', tooltip: 'Modified by TeXRA' });

    disposeContext(context);
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
    const context = makeContext();
    registerInlineCriticism(context as unknown as VSCode.ExtensionContext, hub);

    emitAddOutputFilesRunFact(hub, addOutputFilesPayload(outputPath));
    await setInlineCriticismEnabled(true);
    expect(mocks.diagnosticCollections.at(-1)?.items.get(outputPath)).toBe(
      undefined,
    );

    ProgressEventBus.emit('addOutputFiles', addOutputFilesPayload(outputPath));
    await sleep(20);
    expect(mocks.diagnosticCollections.at(-1)?.items.get(outputPath)).toBe(
      undefined,
    );
    drainBufferedAddOutputFilesBusEvents();

    emitAddOutputFilesRunFact(hub, addOutputFilesPayload(outputPath));
    await waitFor(
      () =>
        (mocks.diagnosticCollections.at(-1)?.items.get(outputPath) ?? [])
          .length > 0,
      'inline criticism diagnostics were not refreshed',
    );
    expect(
      mocks.diagnosticCollections.at(-1)?.items.get(outputPath),
    ).toHaveLength(1);

    await setInlineCriticismEnabled(false);
    emitAddOutputFilesRunFact(hub, addOutputFilesPayload(outputPath));
    expect(mocks.diagnosticCollections.at(-1)?.items.get(outputPath)).toBe(
      undefined,
    );

    disposeContext(context);
  });
});

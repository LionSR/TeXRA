// Node imports
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnOverride } = vi.hoisted(() => ({
  spawnOverride: {
    current: undefined as undefined | ((...args: unknown[]) => unknown),
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      (spawnOverride.current ?? actual.spawn)(...args),
  };
});

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createDirectLspLeanAdapter } from '@tools/lean/direct/directLspAdapter';
import { fileUriToPath, LeanSession } from '@tools/lean/direct/leanSession';
import {
  isLeanServerActive,
  listLeanServers,
} from '@tools/lean/leanServerRegistry';
import { delay } from '@utils/core';
import { splitOutputLines } from '@utils/text/stringUtils';

const FAKE_LAKE = `#!/usr/bin/env node
const fs = require('node:fs');

if (!process.argv.includes('--server')) {
  const delayMs = Number(process.env.TEXRA_FAKE_LEAN_LAKE_DELAY || 0);
  setTimeout(() => process.exit(0), delayMs);
  return;
}

const countPath = process.env.TEXRA_FAKE_LEAN_COUNT;
if (countPath) fs.appendFileSync(countPath, 'start\\n');

let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(\`Content-Length: \${body.length}\\r\\n\\r\\n\`);
  process.stdout.write(body);
}

function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (message.method === 'exit') {
    const delayMs = Number(process.env.TEXRA_FAKE_LEAN_EXIT_DELAY || 0);
    setTimeout(() => process.exit(0), delayMs);
    return;
  }
  if (message.method === 'textDocument/didOpen') {
    if (process.env.TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS === '1') return;
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: message.params.textDocument.uri,
        diagnostics: [
          {
            severity: 1,
            message: 'fake diagnostic',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 }
            },
            source: 'fake-lean'
          }
        ]
      }
    });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length: (\\d+)/i);
    if (!match) throw new Error('missing Content-Length');
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const frameEnd = bodyStart + length;
    if (buffer.length < frameEnd) return;
    const body = buffer.subarray(bodyStart, frameEnd).toString('utf8');
    buffer = buffer.subarray(frameEnd);
    handle(JSON.parse(body));
  }
});
`;

let tempRoot: string;
let projectRoot: string;
let fakeLakePath: string;
let countPath: string;
let filePath: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'texra-direct-lsp-'));
  projectRoot = path.join(tempRoot, 'project');
  mkdirSync(projectRoot);
  writeFileSync(path.join(projectRoot, 'lakefile.toml'), 'name = "Test"\n');
  filePath = path.join(projectRoot, 'Test.lean');
  writeFileSync(filePath, 'example : True := by trivial\n');
  fakeLakePath = path.join(tempRoot, 'fake-lake.js');
  writeFileSync(fakeLakePath, FAKE_LAKE);
  chmodSync(fakeLakePath, 0o755);
  countPath = path.join(tempRoot, 'starts.txt');
  vi.stubEnv('TEXRA_FAKE_LEAN_COUNT', countPath);
  vi.stubEnv('TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS', undefined);
});

afterEach(() => {
  spawnOverride.current = undefined;
  vi.unstubAllEnvs();
  rmSync(tempRoot, { recursive: true, force: true });
});

async function countStarts(): Promise<number> {
  const text = await readFile(countPath, 'utf8').catch(() => '');
  return splitOutputLines(text).length;
}

describe('createDirectLspLeanAdapter', () => {
  const fakeLakeIt = it.skipIf(process.platform === 'win32');

  it('decodes file URIs with platform path semantics', () => {
    const spacedPath = path.join(projectRoot, 'File With Space.lean');
    expect(fileUriToPath(pathToFileURL(spacedPath).toString())).toBe(
      spacedPath,
    );
    expect(fileUriToPath('untitled:Lean')).toBeNull();
  });

  it('rejects ensureReady after disposal through the promise path', async () => {
    const session = new LeanSession({
      workspaceRoot: projectRoot,
      lakeCommand: fakeLakePath,
    });

    await session.dispose();

    await expect(session.ensureReady()).rejects.toThrow(
      'Lean session has been disposed.',
    );
  });

  fakeLakeIt('settles diagnostic waiters during disposal', async () => {
    vi.stubEnv('TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS', '1');
    const session = new LeanSession({
      workspaceRoot: projectRoot,
      lakeCommand: fakeLakePath,
    });
    await session.ensureReady();

    const pendingDiagnostics = session.fetchDiagnostics(filePath);
    const settled = expect(pendingDiagnostics).rejects.toThrow(
      'Lean session has been disposed.',
    );
    await delay(100);
    await session.dispose();
    await settled;
  });

  fakeLakeIt(
    'joins concurrent first-touch requests for the same workspace',
    async () => {
      const adapter = createDirectLspLeanAdapter({ lakeCommand: fakeLakePath });
      try {
        const [first, second] = await Promise.all([
          adapter.fetchDiagnosticsForFile(filePath),
          adapter.fetchDiagnosticsForFile(filePath),
        ]);

        expect(first).toMatchObject({
          ok: true,
          diagnostics: [{ message: 'fake diagnostic' }],
        });
        expect(second).toMatchObject({
          ok: true,
          diagnostics: [{ message: 'fake diagnostic' }],
        });
        expect(await countStarts()).toBe(1);
      } finally {
        await adapter.dispose();
      }
    },
  );

  it('reports a missing lake command as toolchain_unavailable, not "file missing"', async () => {
    const adapter = createDirectLspLeanAdapter({
      lakeCommand: path.join(tempRoot, 'missing-lake'),
    });
    try {
      await expect(
        adapter.fetchDiagnosticsForFile(filePath),
      ).resolves.toMatchObject({ ok: false, kind: 'toolchain_unavailable' });
    } finally {
      await adapter.dispose();
    }
  });

  fakeLakeIt(
    'restarts by replacing the disposed session with a fresh process',
    async () => {
      const adapter = createDirectLspLeanAdapter({ lakeCommand: fakeLakePath });
      try {
        await adapter.fetchDiagnosticsForFile(filePath);
        expect(await countStarts()).toBe(1);

        await adapter.executeProjectCommand('restart_server');

        expect(await countStarts()).toBe(2);
      } finally {
        await adapter.dispose();
      }
    },
  );

  fakeLakeIt(
    'evicts the least-recent workspace when the session cap is reached',
    async () => {
      const second = makeLakeProject(tempRoot, 'project-b');
      const adapter = createDirectLspLeanAdapter({
        lakeCommand: fakeLakePath,
        maxSessions: 1,
        idleTimeoutMs: 0,
      });
      try {
        await adapter.fetchDiagnosticsForFile(filePath);
        await adapter.fetchDiagnosticsForFile(second.filePath);
        expect(await countStarts()).toBe(2);
        expect(activeServerRoots()).toEqual([second.projectRoot]);
      } finally {
        await adapter.dispose();
      }
    },
  );

  fakeLakeIt('keeps more than two active workspaces by default', async () => {
    const second = makeLakeProject(tempRoot, 'project-b');
    const third = makeLakeProject(tempRoot, 'project-c');
    const adapter = createDirectLspLeanAdapter({
      lakeCommand: fakeLakePath,
      idleTimeoutMs: 0,
    });
    try {
      await adapter.fetchDiagnosticsForFile(filePath);
      await adapter.fetchDiagnosticsForFile(second.filePath);
      await adapter.fetchDiagnosticsForFile(third.filePath);
      expect(await countStarts()).toBe(3);
      expect(activeServerRoots()).toEqual([
        projectRoot,
        second.projectRoot,
        third.projectRoot,
      ]);
    } finally {
      await adapter.dispose();
    }
  });

  fakeLakeIt('stops an idle workspace before opening another', async () => {
    const second = makeLakeProject(tempRoot, 'project-b');
    let clock = 0;
    const adapter = createDirectLspLeanAdapter({
      lakeCommand: fakeLakePath,
      maxSessions: 2,
      idleTimeoutMs: 1_000,
      now: () => clock,
    });
    try {
      await adapter.fetchDiagnosticsForFile(filePath);
      clock = 2_000;
      await adapter.fetchDiagnosticsForFile(second.filePath);
      expect(await countStarts()).toBe(2);
      expect(activeServerRoots()).toEqual([second.projectRoot]);
    } finally {
      await adapter.dispose();
    }
  });

  fakeLakeIt(
    'does not stop a session while a diagnostics request is in flight',
    async () => {
      vi.stubEnv('TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS', '1');
      const adapter = createDirectLspLeanAdapter({
        lakeCommand: fakeLakePath,
        idleTimeoutMs: 50,
      });
      const pending = adapter.fetchDiagnosticsForFile(filePath);
      try {
        await delay(700);
        expect(activeServerRoots()).toEqual([projectRoot]);
        await delay(150);
        expect(activeServerRoots()).toEqual([projectRoot]);
        await adapter.dispose();
        await expect(pending).resolves.toMatchObject({
          ok: false,
          kind: 'toolchain_unavailable',
        });
      } finally {
        await adapter.dispose();
        await Promise.allSettled([pending]);
      }
    },
  );

  fakeLakeIt(
    'does not evict a workspace that still has an in-flight request',
    async () => {
      vi.stubEnv('TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS', '1');
      const second = makeLakeProject(tempRoot, 'project-b');
      const adapter = createDirectLspLeanAdapter({
        lakeCommand: fakeLakePath,
        maxSessions: 1,
        idleTimeoutMs: 0,
      });
      const pendingFirst = adapter.fetchDiagnosticsForFile(filePath);
      try {
        await delay(100);
        const pendingSecond = adapter.fetchDiagnosticsForFile(second.filePath);
        await delay(100);
        expect(activeServerRoots()).toEqual([projectRoot]);
        await adapter.dispose();
        await Promise.allSettled([pendingFirst, pendingSecond]);
      } finally {
        await adapter.dispose();
        await Promise.allSettled([pendingFirst]);
      }
    },
  );

  fakeLakeIt('does not start queued servers after dispose', async () => {
    const second = makeLakeProject(tempRoot, 'project-b');
    const third = makeLakeProject(tempRoot, 'project-c');
    const adapter = createDirectLspLeanAdapter({
      lakeCommand: fakeLakePath,
      idleTimeoutMs: 0,
    });
    const pending = Promise.allSettled([
      adapter.fetchDiagnosticsForFile(filePath),
      adapter.fetchDiagnosticsForFile(second.filePath),
      adapter.fetchDiagnosticsForFile(third.filePath),
    ]);
    await adapter.dispose();
    await pending;
    expect(activeServerRoots()).toEqual([]);
    const starts = await countStarts();
    await delay(100);
    expect(await countStarts()).toBe(starts);
  });

  fakeLakeIt(
    'settles a start that was already queued when dispose runs',
    async () => {
      vi.stubEnv('TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS', '1');
      const second = makeLakeProject(tempRoot, 'project-b');
      const adapter = createDirectLspLeanAdapter({
        lakeCommand: fakeLakePath,
        maxSessions: 1,
        idleTimeoutMs: 0,
      });
      const first = adapter.fetchDiagnosticsForFile(filePath);
      try {
        await delay(150);
        expect(activeServerRoots()).toEqual([projectRoot]);
        const queued = adapter.fetchDiagnosticsForFile(second.filePath);
        await delay(50);
        const disposed = adapter.dispose();
        await expect(
          Promise.race([
            queued,
            delay(1_000).then(() => {
              throw new Error('queued start did not settle after dispose');
            }),
          ]),
        ).resolves.toMatchObject({
          ok: false,
          kind: 'toolchain_unavailable',
        });
        await disposed;
      } finally {
        await adapter.dispose();
        await Promise.allSettled([first]);
      }
    },
  );

  fakeLakeIt(
    'does not SIGKILL a live server two seconds after spawn',
    async () => {
      const adapter = createDirectLspLeanAdapter({
        lakeCommand: fakeLakePath,
        idleTimeoutMs: 0,
      });
      try {
        await adapter.fetchDiagnosticsForFile(filePath);
        await delay(2_200);
        expect(activeServerRoots()).toEqual([projectRoot]);
        expect(await countStarts()).toBe(1);
        await expect(
          adapter.fetchDiagnosticsForFile(filePath),
        ).resolves.toMatchObject({ ok: true });
        expect(await countStarts()).toBe(1);
      } finally {
        await adapter.dispose();
      }
    },
  );

  it('waits for the child to close before a failed start finishes disposing', async () => {
    const child = createFakeLeanChild({ closeDelayMs: 80, silent: true });
    spawnOverride.current = () => child;

    const session = new LeanSession({
      workspaceRoot: projectRoot,
      lakeCommand: fakeLakePath,
    });
    const ready = session.ensureReady();
    await delay(20);
    const disposed = session.dispose();
    let finished = false;
    void Promise.allSettled([ready, disposed]).then(() => {
      finished = true;
    });
    await delay(30);
    expect(finished).toBe(false);
    child.closeSoon();
    await disposed;
    await Promise.allSettled([ready]);
    expect(finished).toBe(true);
  });

  fakeLakeIt(
    'does not release a replacement session from a project command that never acquired it',
    async () => {
      vi.stubEnv('TEXRA_FAKE_LEAN_EXIT_DELAY', '150');
      vi.stubEnv('TEXRA_FAKE_LEAN_LAKE_DELAY', '400');
      const second = makeLakeProject(tempRoot, 'project-b');
      const adapter = createDirectLspLeanAdapter({
        lakeCommand: fakeLakePath,
        maxSessions: 1,
        idleTimeoutMs: 40,
      });
      try {
        await adapter.fetchDiagnosticsForFile(filePath);
        await delay(80);
        const build = adapter.executeProjectCommand('build');
        void build.catch(() => undefined);
        await delay(200);
        vi.stubEnv('TEXRA_FAKE_LEAN_SUPPRESS_DIAGNOSTICS', '1');
        const pending = adapter.fetchDiagnosticsForFile(filePath);
        await Promise.allSettled([build]);
        const other = adapter.fetchDiagnosticsForFile(second.filePath);
        await delay(80);
        expect(activeServerRoots()).toContain(projectRoot);
        await adapter.dispose();
        await Promise.allSettled([pending, other]);
      } finally {
        await adapter.dispose();
      }
    },
  );

  it('retries EMFILE after evicting idle sessions without waiting for busy ones', async () => {
    const second = makeLakeProject(tempRoot, 'project-b');
    const third = makeLakeProject(tempRoot, 'project-c');
    let spawnCount = 0;
    let failNextSpawn = false;
    spawnOverride.current = () => {
      spawnCount += 1;
      if (failNextSpawn) {
        failNextSpawn = false;
        throw Object.assign(new Error('too many open files'), {
          code: 'EMFILE',
        });
      }
      return createFakeLeanChild();
    };

    const adapter = createDirectLspLeanAdapter({
      lakeCommand: fakeLakePath,
      idleTimeoutMs: 0,
    });
    try {
      await adapter.fetchDiagnosticsForFile(filePath);
      await adapter.fetchDiagnosticsForFile(second.filePath);

      // Keep the first workspace in-flight so recovery cannot evict it.
      const pendingBusy = adapter.getHoverInfo(filePath, 0, 0);
      await delay(50);

      failNextSpawn = true;
      const started = adapter.fetchDiagnosticsForFile(third.filePath);
      await expect(
        Promise.race([
          started,
          delay(1_000).then(() => {
            throw new Error('EMFILE recovery waited for the busy session');
          }),
        ]),
      ).resolves.toMatchObject({
        ok: true,
        diagnostics: [{ message: 'fake diagnostic' }],
      });
      expect(activeServerRoots()).toEqual([projectRoot, third.projectRoot]);
      expect(spawnCount).toBe(4);
      await adapter.dispose();
      await Promise.allSettled([pendingBusy]);
    } finally {
      await adapter.dispose();
    }
  });

  it('awaits already-disposing sessions before retrying EMFILE', async () => {
    const second = makeLakeProject(tempRoot, 'project-b');
    let spawnCount = 0;
    let firstClosed = false;
    spawnOverride.current = () => {
      spawnCount += 1;
      if (spawnCount > 1 && !firstClosed) {
        throw Object.assign(new Error('too many open files'), {
          code: 'EMFILE',
        });
      }
      const child = createFakeLeanChild({
        closeDelayMs: spawnCount === 1 ? 200 : 0,
      });
      if (spawnCount === 1) {
        child.on('close', () => {
          firstClosed = true;
        });
      }
      return child;
    };

    const adapter = createDirectLspLeanAdapter({
      lakeCommand: fakeLakePath,
      idleTimeoutMs: 30,
    });
    try {
      await adapter.fetchDiagnosticsForFile(filePath);
      await delay(80);
      const started = adapter.fetchDiagnosticsForFile(second.filePath);
      await expect(
        Promise.race([
          started,
          delay(1_000).then(() => {
            throw new Error(
              'EMFILE recovery did not wait for the disposing session',
            );
          }),
        ]),
      ).resolves.toMatchObject({
        ok: true,
        diagnostics: [{ message: 'fake diagnostic' }],
      });
      expect(firstClosed).toBe(true);
      expect(spawnCount).toBe(3);
    } finally {
      await adapter.dispose();
    }
  });

  it('keeps a disposing session reserved until the child closes', async () => {
    let spawnCount = 0;
    spawnOverride.current = () => {
      spawnCount += 1;
      return createFakeLeanChild({ closeDelayMs: 200 });
    };
    const adapter = createDirectLspLeanAdapter({
      lakeCommand: fakeLakePath,
      idleTimeoutMs: 30,
    });
    try {
      await adapter.fetchDiagnosticsForFile(filePath);
      expect(spawnCount).toBe(1);
      await delay(60);
      const pending = adapter.fetchDiagnosticsForFile(filePath);
      await delay(40);
      expect(spawnCount).toBe(1);
      await pending;
      expect(spawnCount).toBe(2);
    } finally {
      await adapter.dispose();
    }
  });

  fakeLakeIt('stops a restarted session after it sits idle', async () => {
    const adapter = createDirectLspLeanAdapter({
      lakeCommand: fakeLakePath,
      idleTimeoutMs: 50,
    });
    try {
      await adapter.fetchDiagnosticsForFile(filePath);
      await adapter.executeProjectCommand('restart_server');
      expect(activeServerRoots()).toEqual([projectRoot]);
      await delay(150);
      expect(activeServerRoots()).toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  fakeLakeIt('treats project commands as session activity', async () => {
    const second = makeLakeProject(tempRoot, 'project-b');
    let clock = 0;
    const adapter = createDirectLspLeanAdapter({
      lakeCommand: fakeLakePath,
      maxSessions: 2,
      idleTimeoutMs: 1_000,
      now: () => clock,
    });
    try {
      await adapter.fetchDiagnosticsForFile(filePath);
      clock = 2_000;
      await adapter.executeProjectCommand('build');
      await adapter.fetchDiagnosticsForFile(second.filePath);
      expect(activeServerRoots()).toEqual([projectRoot, second.projectRoot]);
    } finally {
      await adapter.dispose();
    }
  });

  // Idle eviction is disabled in the run-end tests below (idleTimeoutMs: 0),
  // so the run-end stop is the only mechanism that can remove a server.
  fakeLakeIt('stops the server when the run that started it ends', async () => {
    const adapter = createDirectLspLeanAdapter({
      lakeCommand: fakeLakePath,
      idleTimeoutMs: 0,
    });
    try {
      await asRun('e00001', () => adapter.fetchDiagnosticsForFile(filePath));
      expect(activeServerRoots()).toEqual([projectRoot]);

      await adapter.stopSessionsForRun?.('e00001');

      expect(activeServerRoots()).toEqual([]);
      expect(await countStarts()).toBe(1);
    } finally {
      await adapter.dispose();
    }
  });

  fakeLakeIt(
    'keeps servers started by other runs or outside a run when a run ends',
    async () => {
      const second = makeLakeProject(tempRoot, 'project-b');
      const third = makeLakeProject(tempRoot, 'project-c');
      const adapter = createDirectLspLeanAdapter({
        lakeCommand: fakeLakePath,
        idleTimeoutMs: 0,
      });
      try {
        await asRun('e00001', () => adapter.fetchDiagnosticsForFile(filePath));
        await asRun('e00002', () =>
          adapter.fetchDiagnosticsForFile(second.filePath),
        );
        await adapter.fetchDiagnosticsForFile(third.filePath);
        expect(activeServerRoots()).toEqual([
          projectRoot,
          second.projectRoot,
          third.projectRoot,
        ]);

        await adapter.stopSessionsForRun?.('e00001');

        expect(activeServerRoots()).toEqual([
          second.projectRoot,
          third.projectRoot,
        ]);
      } finally {
        await adapter.dispose();
      }
    },
  );

  fakeLakeIt(
    'stops a reattributed server after its final overlapping lease ends',
    async () => {
      const adapter = createDirectLspLeanAdapter({
        lakeCommand: fakeLakePath,
        idleTimeoutMs: 0,
      });
      try {
        await asRun('e00001', () => adapter.fetchDiagnosticsForFile(filePath));
        expect(activeServerRoots()).toEqual([projectRoot]);
        vi.stubEnv('TEXRA_FAKE_LEAN_LAKE_DELAY', '1500');
        const build = asRun('e00001', () =>
          adapter.executeProjectCommand('build'),
        );
        await asRun('e00002', () => adapter.fetchDiagnosticsForFile(filePath));

        // e00002's file request transfers ownership while e00001's build still
        // holds the shared session. Its stop cannot interrupt that older lease,
        // but is retained and disposes the server when the build releases it.
        await adapter.stopSessionsForRun?.('e00002');
        expect(activeServerRoots()).toEqual([projectRoot]);

        await build;
        expect(activeServerRoots()).toEqual([]);
      } finally {
        await adapter.dispose();
      }
    },
  );

  fakeLakeIt(
    'cancels a deferred stop when a later run takes ownership',
    async () => {
      const adapter = createDirectLspLeanAdapter({
        lakeCommand: fakeLakePath,
        idleTimeoutMs: 0,
      });
      try {
        await asRun('e00001', () => adapter.fetchDiagnosticsForFile(filePath));
        vi.stubEnv('TEXRA_FAKE_LEAN_LAKE_DELAY', '1500');
        const build = asRun('e00001', () =>
          adapter.executeProjectCommand('build'),
        );
        await asRun('e00002', () => adapter.fetchDiagnosticsForFile(filePath));
        await adapter.stopSessionsForRun?.('e00002');

        await asRun('e00003', () => adapter.fetchDiagnosticsForFile(filePath));
        await build;
        expect(activeServerRoots()).toEqual([projectRoot]);

        await adapter.stopSessionsForRun?.('e00003');
        expect(activeServerRoots()).toEqual([]);
      } finally {
        await adapter.dispose();
      }
    },
  );

  fakeLakeIt('reattributes project commands to their current run', async () => {
    const adapter = createDirectLspLeanAdapter({
      lakeCommand: fakeLakePath,
      idleTimeoutMs: 0,
    });
    try {
      await asRun('e00001', () => adapter.fetchDiagnosticsForFile(filePath));
      await asRun('e00002', () => adapter.executeProjectCommand('build'));

      await adapter.stopSessionsForRun?.('e00001');
      expect(activeServerRoots()).toEqual([projectRoot]);

      await adapter.stopSessionsForRun?.('e00002');
      expect(activeServerRoots()).toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  fakeLakeIt(
    'reattributes a reused server to the run that leases it',
    async () => {
      const adapter = createDirectLspLeanAdapter({
        lakeCommand: fakeLakePath,
        idleTimeoutMs: 0,
      });
      try {
        await asRun('e00001', () => adapter.fetchDiagnosticsForFile(filePath));
        await asRun('e00002', () => adapter.fetchDiagnosticsForFile(filePath));
        expect(await countStarts()).toBe(1);

        // The server now belongs to the run that last used it, so the
        // original run's end leaves it running.
        await adapter.stopSessionsForRun?.('e00001');
        expect(activeServerRoots()).toEqual([projectRoot]);

        await adapter.stopSessionsForRun?.('e00002');
        expect(activeServerRoots()).toEqual([]);
      } finally {
        await adapter.dispose();
      }
    },
  );

  fakeLakeIt(
    'reattributes a restarted server to the restarting run',
    async () => {
      const adapter = createDirectLspLeanAdapter({
        lakeCommand: fakeLakePath,
        idleTimeoutMs: 0,
      });
      try {
        await asRun('e00001', () => adapter.fetchDiagnosticsForFile(filePath));
        await asRun('e00002', () =>
          adapter.executeProjectCommand('restart_server'),
        );
        expect(await countStarts()).toBe(2);

        // The replacement process was started by e00002, so e00001's end must
        // leave it alone and e00002's end must dispose it.
        await adapter.stopSessionsForRun?.('e00001');
        expect(activeServerRoots()).toEqual([projectRoot]);

        await adapter.stopSessionsForRun?.('e00002');
        expect(activeServerRoots()).toEqual([]);
      } finally {
        await adapter.dispose();
      }
    },
  );
});

/** Run `fn` with the ambient run context of the given agent run. */
function asRun<T>(
  executionId: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return withRunContext(createRunContext({ executionId }), fn);
}

function makeLakeProject(
  root: string,
  name: string,
): { projectRoot: string; filePath: string } {
  const projectRoot = path.join(root, name);
  mkdirSync(projectRoot);
  writeFileSync(path.join(projectRoot, 'lakefile.toml'), `name = "${name}"\n`);
  const filePath = path.join(projectRoot, 'Test.lean');
  writeFileSync(filePath, 'example : True := by trivial\n');
  return { projectRoot, filePath };
}

function activeServerRoots(): string[] {
  return listLeanServers()
    .filter(isLeanServerActive)
    .map((info) => info.workspaceRoot)
    .toSorted((a, b) => a.localeCompare(b));
}

interface FakeLeanChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number | undefined;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  closeSoon: () => void;
}

function createFakeLeanChild(options?: {
  closeDelayMs?: number;
  silent?: boolean;
}): FakeLeanChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = Buffer.alloc(0);
  const closeDelayMs = options?.closeDelayMs ?? 0;

  function send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    stdout.write(body);
  }

  function handle(message: {
    id?: number;
    method?: string;
    params?: { textDocument?: { uri?: string } };
  }): void {
    if (message.method === 'initialize') {
      if (options?.silent) return;
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      return;
    }
    if (message.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: message.id, result: null });
      return;
    }
    if (message.method === 'textDocument/didOpen') {
      const uri = message.params?.textDocument?.uri;
      if (!uri) return;
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [
            {
              severity: 1,
              message: 'fake diagnostic',
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              source: 'fake-lean',
            },
          ],
        },
      });
    }
  }

  stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) return;
      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const frameEnd = bodyStart + length;
      if (buffer.length < frameEnd) return;
      const body = buffer.subarray(bodyStart, frameEnd).toString('utf8');
      buffer = buffer.subarray(frameEnd);
      handle(JSON.parse(body) as Parameters<typeof handle>[0]);
    }
  });

  const events = new EventEmitter();
  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    emit: events.emit.bind(events),
    kill(signal?: NodeJS.Signals) {
      if (this.exitCode != null || this.signalCode != null) return true;
      this.killed = true;
      this.exitCode = 0;
      this.emit('exit', 0, signal ?? null);
      const finish = () => {
        if (!stdin.destroyed) stdin.end();
        if (!stdout.destroyed) stdout.end();
        if (!stderr.destroyed) stderr.end();
        this.emit('close', 0, null);
      };
      if (closeDelayMs > 0) setTimeout(finish, closeDelayMs);
      else finish();
      return true;
    },
    closeSoon() {
      this.exitCode = 1;
      this.emit('close', 1, null);
    },
  });
  return child;
}

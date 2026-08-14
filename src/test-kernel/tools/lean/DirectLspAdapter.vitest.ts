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
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  process.exit(0);
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
    process.exit(0);
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
});

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

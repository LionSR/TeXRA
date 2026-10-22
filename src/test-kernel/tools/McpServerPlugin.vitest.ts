import '@test/support/defaultSessionTestSetup';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Scope,
} from 'effect';
import { describe, expect } from 'vitest';

import { guardedToolCall } from '@agent/runtime/loop/toolGuard';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import type { RunId } from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { hostStores } from '@test/support/setupPlatform';
import { resolveTestStep } from '@test/support/stepToolsTestUtils';
import { toolCatalogLayer } from '@tools/liveTools';
import { mcpPluginLoader } from '@tools/mcp/mcpConfig';
import { toolTable } from '@tools/toolTable';
import { ProjectEnvironment } from '@utils/system/nodeWorkspace';
import {
  autoDecideRequests,
  createRecordingHost,
  decideRequest,
  sessionWithInteractions,
} from '../agent/progressTestUtils';

/** The per-install key env values are digested under, fixed. */
const TEST_REVISION_KEY = Effect.succeed('00'.repeat(32));

/** A stdio MCP server listing one tool, `echo`, that answers one call. */
const FIXTURE_SERVER = `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], String(process.pid));
if (process.argv[3])
  fs.writeFileSync(process.argv[3], JSON.stringify({ PATH: process.env.PATH, mark: process.env.FIXTURE_MARK }));
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
require('node:readline')
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize')
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '0' },
      } });
    else if (method === 'tools/list')
      send({ jsonrpc: '2.0', id, result: { tools: [{
        name: 'echo',
        description: 'Echo the text.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }] } });
    else if (method === 'tools/call' && process.env.FIXTURE_MODE === 'exit') {
      // A grandchild holding stdout answers once this process is gone: it
      // says it is up, this process exits, and the end of their IPC channel
      // is its cue. Detached, since on Windows libuv puts a child that is not
      // in a kill-on-close job, and it would die with this process unheard.
      const answer = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'late' }] } };
      require('node:child_process')
        .spawn(
          process.execPath,
          [
            '-e',
            "process.on('disconnect', () => process.stdout.write(process.argv[1])); process.send('up');",
            JSON.stringify(answer) + '\\n',
          ],
          { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], detached: true, windowsHide: true },
        )
        .once('message', () => process.exit(0));
    }
    else if (method === 'tools/call')
      send({ jsonrpc: '2.0', id, result: { content: [{
        type: 'text',
        text: 'echo: ' + params.arguments.text + ' (key: ' + (process.env.FIXTURE_API_KEY ?? 'unset') + ')',
      }] } });
    else if (id !== undefined)
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: method } });
  });
`;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The tool table over the MCP config in `dir`, read through the node FileSystem. */
const mcpToolTableLayer = (dir: string) =>
  Layer.unwrap(
    FileSystem.FileSystem.useSync((fs) =>
      toolCatalogLayer(toolTable([]), {
        loader: mcpPluginLoader(
          fs,
          path.join(dir, 'mcp.json'),
          TEST_REVISION_KEY,
        ),
      }),
    ),
  ).pipe(Layer.provide(nodePlatformLayer));

describe('MCP server plugins', () => {
  // it.live: a real child process answers over stdio, and the approval's
  // `request.opened` row is delivered by a consumer on the process runtime.
  it.live(
    'offers a configured server tools, gates each call on approval, and stops the server with the composition',
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'texra-mcp-'));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const pidFile = path.join(dir, 'pid');
        writeFileSync(path.join(dir, 'server.cjs'), FIXTURE_SERVER);
        const writeConfig = (mode: string) =>
          writeFileSync(
            path.join(dir, 'mcp.json'),
            JSON.stringify({
              mcpServers: {
                fixture: {
                  command: process.execPath,
                  args: [path.join(dir, 'server.cjs'), pidFile],
                  env: { FIXTURE_MODE: mode },
                },
              },
            }),
          );
        writeConfig('a');
        // A credential-shaped variable of this process never reaches the
        // server unless its entry names it.
        process.env.FIXTURE_API_KEY = 'secret';
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => delete process.env.FIXTURE_API_KEY),
        );

        const services = yield* Layer.build(
          Layer.mergeAll(
            mcpToolTableLayer(dir),
            LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
          ),
        );
        const open = (pin: Scope.Scope) =>
          resolveTestStep({
            tools: [{ name: 'mcp__fixture__*' }],
            injectTools: false,
            stores: hostStores(),
            workspaceRoot: undefined,
            host: 'cli',
          }).pipe(Scope.provide(pin), Effect.provideContext(services));
        const pin = yield* Scope.make();
        const resolved = yield* open(pin);
        expect([...resolved.held.warnings, ...resolved.warnings]).toEqual([]);
        expect(resolved.definitions).toEqual([
          expect.objectContaining({
            name: 'mcp__fixture__echo',
            parameters: expect.objectContaining({ required: ['text'] }),
          }),
        ]);
        const pid = Number(readFileSync(pidFile, 'utf8'));
        expect(isAlive(pid)).toBe(true);

        // An edited env value is a new revision: a run opened now gets its
        // own server, whose tools supersede the old revision's in the catalog
        // while the open run keeps the server it started with.
        writeConfig('b');
        const editedPin = yield* Scope.make();
        yield* open(editedPin);
        const editedPid = Number(readFileSync(pidFile, 'utf8'));
        expect(editedPid).not.toBe(pid);
        yield* Scope.close(editedPin, Exit.void);

        // The call goes through the loop's guard: a bash request the
        // session's approval authority opens, answered here.
        const runId = 'a99f0000c0d1' as RunId;
        const session = yield* Effect.acquireRelease(
          sessionWithInteractions(createRecordingHost().interactions),
          (session) => closeSessionOf(session),
        );
        publishTestRunStart(session, runId);
        yield* session.log.settled;
        const requestOpened = yield* Deferred.make<void>();
        const requests = yield* Effect.acquireRelease(
          Effect.sync(() =>
            autoDecideRequests(session, () => {
              Deferred.doneUnsafe(requestOpened, Effect.void);
              return null;
            }),
          ),
          (requests) => Effect.sync(() => requests.detach()),
        );
        const tool = resolved.registry.get('mcp__fixture__echo')!;
        const call = yield* Effect.forkChild(
          guardedToolCall(tool, { text: 'hi' }).pipe(
            Effect.provide(
              nativeToolTestLayer({
                run: { session, runId, toolPolicy: {} },
              }),
            ),
          ),
        );
        yield* Deferred.await(requestOpened);
        const opened = requests.opened[0]!;
        expect(opened.payload).toMatchObject({
          kind: 'bash',
          data: { command: 'mcp fixture echo {"text":"hi"}' },
        });
        decideRequest(
          session,
          { runId, requestId: opened.requestId },
          { action: 'approve' },
        );
        expect(yield* Fiber.join(call)).toMatchObject({
          status: 'executed',
          output: 'echo: hi (key: unset)',
        });

        // The run's pin was the server's last holder: closing it stops the
        // server.
        yield* Scope.close(pin, Exit.void);
        yield* Effect.gen(function* () {
          while (isAlive(pid) || isAlive(editedPid))
            yield* Effect.sleep(Duration.millis(20));
        }).pipe(Effect.timeout(Duration.seconds(5)));
        expect([isAlive(pid), isAlive(editedPid)]).toEqual([false, false]);
      }).pipe(Effect.scoped, Effect.provide(nativeToolTestLayer())),
    20_000,
  );

  // A server's 'exit' can precede the end of its stdout: an answer written
  // after it is the call's result, not a disposal.
  it.live('answers a call whose answer arrives after its server exited', () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'texra-mcp-'));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      writeFileSync(path.join(dir, 'server.cjs'), FIXTURE_SERVER);
      writeFileSync(
        path.join(dir, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            fixture: {
              command: process.execPath,
              args: [path.join(dir, 'server.cjs'), path.join(dir, 'pid')],
              env: { FIXTURE_MODE: 'exit' },
            },
          },
        }),
      );
      const resolved = yield* resolveTestStep({
        tools: [{ name: 'mcp__fixture__*' }],
        injectTools: false,
        stores: hostStores(),
        workspaceRoot: undefined,
        host: 'cli',
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            mcpToolTableLayer(dir),
            LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
          ),
        ),
      );
      const tool = resolved.registry.get('mcp__fixture__echo')!;
      expect(yield* tool.call({ text: 'hi' })).toMatchObject({
        status: 'executed',
        output: 'late',
      });
    }).pipe(Effect.scoped, Effect.provide(nativeToolTestLayer())),
  );

  it.live(
    'builds the composition without a server that fails to start, and says so in the transcript',
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'texra-mcp-'));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        writeFileSync(
          path.join(dir, 'mcp.json'),
          JSON.stringify({
            mcpServers: {
              broken: { command: path.join(dir, 'no-such-server') },
              'bad name!': { command: 'node' },
            },
          }),
        );
        const resolved = yield* resolveTestStep({
          tools: [{ name: 'mcp__broken__*' }, { name: 'grep' }],
          injectTools: false,
          stores: hostStores(),
          workspaceRoot: undefined,
          host: 'cli',
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              mcpToolTableLayer(dir),
              LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
            ),
          ),
        );
        expect(resolved.definitions).toEqual([]);
        expect([...resolved.held.warnings, ...resolved.warnings]).toEqual([
          expect.stringContaining('MCP server "bad name!"'),
          expect.stringContaining('MCP server "broken" did not start'),
          'Declared tool not found in registry: grep',
        ]);
      }).pipe(Effect.scoped, Effect.provide(nativeToolTestLayer())),
  );

  // The command is pinned on the extended process PATH, so a project `.env`
  // PATH must not choose the binary the server runs; its other variables do
  // reach the server.
  it.live(
    "spawns a server on the extended process PATH, not the project's .env PATH",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'texra-mcp-'));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const envFile = path.join(dir, 'env.json');
        writeFileSync(path.join(dir, 'server.cjs'), FIXTURE_SERVER);
        writeFileSync(
          path.join(dir, 'mcp.json'),
          JSON.stringify({
            mcpServers: {
              fixture: {
                command: process.execPath,
                args: [
                  path.join(dir, 'server.cjs'),
                  path.join(dir, 'pid'),
                  envFile,
                ],
              },
            },
          }),
        );
        const sentinel = path.join(dir, 'project-bin');
        const resolved = yield* resolveTestStep({
          tools: [{ name: 'mcp__fixture__*' }],
          injectTools: false,
          stores: hostStores(),
          workspaceRoot: undefined,
          host: 'cli',
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              mcpToolTableLayer(dir),
              LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
            ),
          ),
          Effect.provideService(ProjectEnvironment, {
            PATH: sentinel,
            FIXTURE_MARK: 'from-dotenv',
          }),
        );
        expect([...resolved.held.warnings, ...resolved.warnings]).toEqual([]);
        const seen = JSON.parse(readFileSync(envFile, 'utf8'));
        expect(seen.mark).toBe('from-dotenv');
        expect(seen.PATH).not.toContain(sentinel);
        expect(seen.PATH.split(path.delimiter)).toEqual(
          expect.arrayContaining(
            (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(nativeToolTestLayer())),
    20_000,
  );

  it.live('reports an invalid config without quoting its text', () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'texra-mcp-'));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const file = path.join(dir, 'mcp.json');
      // An unquoted value: V8's message for it quotes the surrounding text.
      writeFileSync(
        file,
        '{"mcpServers": {"s": {"command": "x", "env": {"K": sk-secret}}}}',
      );
      const fs = yield* FileSystem.FileSystem;
      const { plugins, warnings } = yield* mcpPluginLoader(
        fs,
        file,
        TEST_REVISION_KEY,
      )(['mcp__s__*']);
      expect(plugins).toEqual([]);
      expect(warnings).toEqual([`${file} is not valid JSON: Unexpected token`]);
    }).pipe(Effect.scoped, Effect.provide(nodePlatformLayer)),
  );
});

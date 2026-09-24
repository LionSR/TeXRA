/**
 * One stdio MCP server, brought up in a scope: spawned with a scrubbed
 * environment, initialized, its tools listed, and stopped (SIGTERM, then
 * SIGKILL) when the scope closes. The scope is the one the composition entry
 * that includes the server builds it in (`@tools/compositions`), so the
 * process lives exactly as long as some open composition names its spec.
 *
 * JSON-RPC runs over the same Effect connection the Lean language server
 * uses (`@tools/jsonRpc`), in newline framing. Each listed tool becomes a
 * runtime tool named `mcp__<server>__<tool>` whose JSON Schema passes through
 * as its parameters. Every call is approval-gated through the loop's one
 * guard (`agent/runtime/loop/toolGuard.ts`, the session's bash approval), is
 * never parallel-safe (an outcome-unknown call on resume goes to the human),
 * and is bounded by a timeout and an output cap.
 *
 * A server that fails to spawn, initialize or list answers its failure and
 * no tools, with a warning in the process log; the run that names it shows
 * the failure in its transcript.
 */
import { createHash } from 'node:crypto';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import {
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Ref,
  Scope,
  Stream,
} from 'effect';
import {
  ChildProcess,
  type ChildProcessSpawner,
} from 'effect/unstable/process';
import { z } from 'zod';

import type { RuntimeTool } from '@agent/runtime/ToolServices';
import {
  TOOL_RESULT_TRUNCATION_HEAD_CHARS,
  TOOL_RESULT_TRUNCATION_TAIL_CHARS,
} from '@agent/runtime/run/toolResultText';
import { withLogChannel } from '@logger/effectLog';
import type { ToolResult } from '@shared/schemas';
import { makeJsonRpcConnection, type JsonRpcConnection } from '@tools/jsonRpc';
import { errorResult, executed } from '@tools/core/result';
import type { LoadedPluginTools } from '@tools/toolTable';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { appendHead, appendTail } from '@utils/text/appendTail';

import type { McpServerConfig } from './mcpConfig';

const CHANNEL = 'mcp';

/** Every MCP tool's name starts with this, then `<server>__<tool>`. */
const MCP_TOOL_PREFIX = 'mcp__';
/** The protocol revision TeXRA speaks; a server answers the one it speaks. */
const PROTOCOL_VERSION = '2025-06-18';
const START_TIMEOUT = Duration.seconds(30);
const CALL_TIMEOUT = Duration.seconds(60);
const STOP_TIMEOUT = Duration.seconds(2);
const STDERR_TAIL_LIMIT = 2048;
/** Function-name contract every provider accepts. */
const MAX_TOOL_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const NAME_HASH_LENGTH = 12;

/**
 * Credential-shaped variables stay out of a server's environment unless its
 * config entry names them in `env`: TeXRA's provider keys must never reach a
 * third-party process implicitly.
 */
const SENSITIVE_ENV_NAME = /KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL/i;

/** The server could not be spawned, initialized or listed. */
class McpStartError extends Data.TaggedError('McpStartError')<{
  readonly message: string;
}> {}

const InitializeResultSchema = z.looseObject({
  protocolVersion: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
});

const ListToolsResultSchema = z.looseObject({
  tools: z.array(
    z.looseObject({
      name: z.string().min(1),
      description: z.string().nullish(),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  ),
  nextCursor: z.string().nullish(),
});

const CallToolResultSchema = z.looseObject({
  content: z
    .array(z.looseObject({ type: z.string(), text: z.string().nullish() }))
    .prefault([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().nullish(),
});

/** A call's arguments: the JSON object the server's schema describes. */
const McpArgumentsSchema = z.record(z.string(), z.unknown());

/** The plugin id of the server named `server`. */
export const mcpPluginId = (server: string): string => `mcp:${server}`;

/**
 * The server an MCP tool name (or `mcp__<server>__*` wildcard) names, or
 * `undefined` for any other tool name.
 */
export function mcpServerOfToolName(name: string): string | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const separator = name.indexOf('__', MCP_TOOL_PREFIX.length);
  return separator > MCP_TOOL_PREFIX.length
    ? name.slice(MCP_TOOL_PREFIX.length, separator)
    : undefined;
}

/**
 * The model-facing name of one server tool: `mcp__<server>__<tool>` when
 * that is already a valid function name, else the name with invalid
 * characters replaced and cut to fit, plus a hash of the identity so two
 * tools never collapse into one name.
 */
function mcpToolName(server: string, tool: string): string {
  const joined = `${MCP_TOOL_PREFIX}${server}__${tool}`;
  const normalized = joined.replaceAll(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_TOOL_NAME_LENGTH)
    return normalized;
  const hash = createHash('sha256')
    .update(`${server}\0${tool}`)
    .digest('hex')
    .slice(0, NAME_HASH_LENGTH);
  return `${normalized.slice(0, MAX_TOOL_NAME_LENGTH - NAME_HASH_LENGTH - 1)}_${hash}`;
}

/** The parent environment minus credential-shaped names, plus the entry's. */
function serverEnv(config: McpServerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_NAME.test(name))
      env[name] = value;
  }
  return { ...env, ...config.env };
}

const decode = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  what: string,
): Effect.Effect<T, McpStartError> => {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new McpStartError({
          message: `Malformed ${what} result: ${z.prettifyError(parsed.error)}`,
        }),
      );
};

/**
 * The text a call result carries, cut head and tail past the cap a shell
 * command's output takes, since a long result's summary or error sits at its
 * end.
 */
function resultText(result: z.infer<typeof CallToolResultSchema>): string {
  const parts = result.content.map((item) =>
    item.type === 'text' && item.text != null
      ? item.text
      : `[${item.type} content omitted]`,
  );
  if (parts.length === 0 && result.structuredContent !== undefined)
    parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n');
  const cap =
    TOOL_RESULT_TRUNCATION_HEAD_CHARS + TOOL_RESULT_TRUNCATION_TAIL_CHARS;
  if (text.length <= cap) return text;
  const head = appendHead('', text, TOOL_RESULT_TRUNCATION_HEAD_CHARS);
  const tail = appendTail('', text, TOOL_RESULT_TRUNCATION_TAIL_CHARS);
  return `${head}\n\n[... ${(text.length - head.length - tail.length).toLocaleString()} characters elided ...]\n\n${tail}`;
}

/** One listed tool as a runtime tool over the server's connection. */
function mcpTool(
  server: string,
  rpc: JsonRpcConnection,
  listed: z.infer<typeof ListToolsResultSchema>['tools'][number],
): RuntimeTool {
  const name = mcpToolName(server, listed.name);
  const describe = (input: unknown) =>
    `mcp ${server} ${listed.name} ${JSON.stringify(input)}`;
  return {
    definition: {
      name,
      description:
        listed.description ??
        `The "${listed.name}" tool of the MCP server "${server}".`,
      // Providers take an object schema; MCP does not require the top-level
      // `type`, and a tool's arguments are always an object.
      parameters: { ...listed.inputSchema, type: 'object' },
    },
    requiresApproval: true,
    slow: true,
    // The call as the approval prompt shows it; the loop asks the session's
    // one approval authority before the body runs.
    guard: {
      bash: (input: unknown) => Effect.succeed(describe(input)),
      cwd: 'unknown',
    },
    call: (rawInput) => {
      const args = McpArgumentsSchema.safeParse(rawInput);
      if (!args.success)
        return Effect.succeed(
          errorResult('Invalid input: the arguments must be a JSON object.'),
        );
      return rpc
        .request('tools/call', { name: listed.name, arguments: args.data })
        .pipe(
          Effect.map((raw): ToolResult => {
            const result = CallToolResultSchema.safeParse(raw);
            if (!result.success)
              return errorResult(
                `MCP server "${server}" returned a malformed result: ${z.prettifyError(result.error)}`,
              );
            const text = resultText(result.data);
            return result.data.isError === true
              ? errorResult(text || `${listed.name} failed.`)
              : executed(text, `${server}: ${listed.name}`);
          }),
          Effect.timeoutOrElse({
            duration: CALL_TIMEOUT,
            orElse: () =>
              Effect.succeed(
                errorResult(
                  `MCP tool ${listed.name} timed out after ${Duration.toSeconds(CALL_TIMEOUT)}s.`,
                ),
              ),
          }),
          Effect.catchTag(
            ['JsonRpcRequestError', 'JsonRpcConnectionDisposed'],
            (error) =>
              Effect.succeed(
                errorResult(
                  `MCP server "${server}" failed ${listed.name}: ${error.message}`,
                ),
              ),
          ),
        );
    },
  };
}

/** SIGTERM the process and wait for it, escalating to SIGKILL. */
const stopProcess = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  handle.kill({ forceKillAfter: STOP_TIMEOUT }).pipe(
    Effect.catch((error) =>
      Effect.logDebug(`kill failed: ${error.message}`).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
    Effect.andThen(
      Effect.ignore(handle.exitCode).pipe(Effect.timeoutOption(STOP_TIMEOUT)),
    ),
  );

/** Spawn, initialize and list, in the caller's scope. */
const connect = (config: McpServerConfig) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(config.command, [...config.args], {
      env: serverEnv(config),
      extendEnv: false,
    }).pipe(
      Effect.mapError(
        (error) =>
          new McpStartError({
            message: `Failed to spawn ${config.command}: ${toErrorMessage(error.reason.cause ?? error)}`,
          }),
      ),
    );
    yield* Effect.addFinalizer(() => stopProcess(handle));

    const stderrTail = yield* Ref.make('');
    yield* Effect.forkScoped(
      handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stderrTail, (tail) =>
            (tail + chunk).slice(-STDERR_TAIL_LIMIT),
          ),
        ),
        Effect.ignore,
      ),
    );

    const rpc = yield* makeJsonRpcConnection({
      input: handle.stdout,
      output: handle.stdin,
      framing: 'newline',
      onNotification: (method) =>
        Effect.logDebug(`[${config.name}] ${method}`).pipe(
          withLogChannel(CHANNEL),
        ),
      onRequest: (method) =>
        method === 'ping' ? Effect.succeed({}) : undefined,
    });
    // The process ended: fail what waits on it, with its exit and stderr.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const exit = yield* Effect.result(handle.exitCode);
        const tail = (yield* Ref.get(stderrTail)).trim();
        const code = exit._tag === 'Success' ? exit.success : 'unknown';
        yield* rpc.close(
          `MCP server "${config.name}" exited (code ${code})${tail ? `: ${tail}` : ''}`,
        );
      }),
    );

    const failed = (error: { readonly message: string }) =>
      new McpStartError({ message: error.message });
    const initialized = yield* rpc
      .request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'texra', version: '1' },
      })
      .pipe(Effect.mapError(failed));
    yield* decode(InitializeResultSchema, initialized, 'initialize');
    yield* rpc.notify('notifications/initialized');

    const tools = new Map<string, RuntimeTool>();
    let cursor: string | undefined;
    do {
      const page = yield* decode(
        ListToolsResultSchema,
        yield* rpc
          .request('tools/list', cursor === undefined ? {} : { cursor })
          .pipe(Effect.mapError(failed)),
        'tools/list',
      );
      for (const listed of page.tools) {
        const tool = mcpTool(config.name, rpc, listed);
        tools.set(tool.definition.name, tool);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return tools;
  });

/** The spawner the server runs under, over Node's filesystem and path. */
const spawnerLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

/**
 * Bring `config`'s server up in the caller's scope, answering its tools, or
 * its failure (with the process already stopped) and none.
 */
export const acquireMcpServer = (
  config: McpServerConfig,
): Effect.Effect<LoadedPluginTools, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope, 'sequential');
    const result = yield* connect(config).pipe(
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new McpStartError({
              message: `No answer within ${Duration.toSeconds(START_TIMEOUT)}s`,
            }),
          ),
      }),
      Scope.provide(scope),
      Effect.provide(spawnerLayer),
      Effect.result,
    );
    if (result._tag === 'Success') return { tools: result.success };
    yield* Scope.close(scope, Exit.void);
    const failure = `MCP server "${config.name}" did not start: ${result.failure.message}`;
    yield* Effect.logWarning(failure).pipe(withLogChannel(CHANNEL));
    return { tools: new Map(), failure };
  });

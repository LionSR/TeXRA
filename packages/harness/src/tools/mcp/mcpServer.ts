/**
 * One stdio MCP server, brought up in a scope: spawned with a scrubbed
 * environment, initialized, its tools listed, and stopped (SIGTERM, then
 * SIGKILL) when the scope closes. The scope is its project's catalog entry
 * for its spec, revision and project variables (`ToolCatalog`), so the
 * process lives while some open run or step of that project holds it and
 * for the catalog's idle time after the last one lets go
 * (`projectServers`, `./mcpConfig`).
 *
 * JSON-RPC runs over the harness's Effect connection, in newline framing.
 * Each listed tool becomes a runtime tool named `mcp__<server>__<tool>`
 * whose JSON Schema passes through as its parameters. Every call is
 * approval-gated through the loop's one guard (the session's bash approval),
 * is never parallel-safe, is replay-safe only when its server marks it
 * read-only or idempotent (any other interrupted call finishes as outcome
 * unknown on resume, and the model decides), and is bounded by the
 * third-party deadline (`@tools/thirdPartyTool`) and an output cap.
 *
 * A server that fails to spawn, initialize or list answers its failure and
 * no tools, with a warning in the process log; the run that names it shows
 * the failure in its transcript.
 */
import { Duration, Effect, Exit, Result, Schema, Scope } from 'effect';
import { decodingDefault } from '@shared/schemas';
import { ChildProcess, type ChildProcessSpawner } from 'effect/process';
import { SubscriptionAccounts } from '@texra-ai/llm/node';

import type { ITool } from '@tools/core/ToolTypes';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import { capToolResultText } from '@shared/toolResultText';
import type { McpServerConfig } from '@common/plugins/mcpServers';
import { withLogChannel } from '@logger/effectLog';
import type { ToolResult } from '@shared/schemas';
import { MCP_TOOL_PREFIX } from '@shared/tools/toolDisplayName';
import { connectJsonRpcProcess, type JsonRpcConnection } from '@tools/jsonRpc';
import { errorResult, executed } from '@tools/core/result';
import { thirdPartyCommand, withinDeadline } from '@tools/thirdPartyTool';
import { environment, ProjectEnvironment } from '@utils/system/nodeWorkspace';
import { envNameKey, withCommandDirs } from '@utils/system/platformPaths';
import { truncatedHexId } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { LoadedPluginTools } from './mcpConfig';

const CHANNEL = 'mcp';

/** The protocol revision the harness asks for. A server that does not speak
 *  it answers with its own, which is accepted: effect/ai's McpClient fails
 *  any answer but the revision it asked for, so a server on an older one
 *  would start with no tools. */
const PROTOCOL_VERSION = '2025-06-18';
const START_TIMEOUT = Duration.seconds(30);
const STOP_TIMEOUT = Duration.seconds(2);
const STDERR_TAIL_LIMIT = 2048;
/** Function-name contract every provider accepts. */
const MAX_TOOL_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const NAME_HASH_LENGTH = 12;

/** Credential-shaped variables stay out of a server's environment unless its
 *  config entry names them in `env`: the host app's provider keys must never
 *  reach a third-party process implicitly. */
const SENSITIVE_ENV_NAME = /KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL/i;

/** The server could not be spawned, initialized or listed. */
class McpStartError extends Schema.TaggedError<McpStartError>()(
  'McpStartError',
  { message: Schema.String },
) {}

// Result shapes name only the fields read here; a struct drops the rest.
const InitializeResultSchema = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Schema.Record(Schema.String, Schema.Unknown),
});

const ListToolsResultSchema = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      description: Schema.optional(Schema.NullOr(Schema.String)),
      inputSchema: Schema.Record(Schema.String, Schema.Unknown),
      /** MCP `ToolAnnotations`: hints only, each `false` when absent. */
      annotations: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            readOnlyHint: Schema.optional(Schema.NullOr(Schema.Boolean)),
            idempotentHint: Schema.optional(Schema.NullOr(Schema.Boolean)),
          }),
        ),
      ),
    }),
  ),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const CallToolResultSchema = Schema.Struct({
  content: decodingDefault(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
    [],
  ),
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

/** A call's arguments: the JSON object the server's schema describes. */
const McpArgumentsSchema = Schema.Record(Schema.String, Schema.Unknown);

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
  const suffix = truncatedHexId(`${server}\0${tool}`, NAME_HASH_LENGTH);
  return `${normalized.slice(0, MAX_TOOL_NAME_LENGTH - NAME_HASH_LENGTH - 1)}_${suffix}`;
}

const isPathName = (name: string) => envNameKey(name) === 'PATH';
/** The process's environment with the project's `.env` over it, minus
 *  credential-shaped names, plus the entry's, on the extended process PATH
 *  its command is pinned on (`externalFiles`), so the pinned binary runs. */
const serverEnv = Effect.fn('serverEnv')(function* (config: McpServerConfig) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const [name, value] of Object.entries(yield* environment)) {
    if (value === undefined || SENSITIVE_ENV_NAME.test(name)) continue;
    if (!isPathName(name)) env[name] = value;
    else if (Object.hasOwn(yield* ProjectEnvironment, name))
      yield* Effect.logWarning(
        `MCP server "${config.name}" ignores the project's .env ${name}: its command is pinned on the extended process PATH.`,
      ).pipe(withLogChannel(CHANNEL));
  }
  for (const [name, value] of Object.entries(config.env))
    env[isPathName(name) ? 'PATH' : name] = value;
  return yield* withCommandDirs(env);
});

const decode = <T>(
  schema: Schema.Codec<T>,
  value: unknown,
  what: string,
): Effect.Effect<T, McpStartError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (error) =>
        new McpStartError({
          message: `Malformed ${what} result: ${error.message}`,
        }),
    ),
  );

/** The text a call result carries, within the cap every tool result takes:
 *  a server is another program, so its result is cut before it is stored. */
function resultText(result: typeof CallToolResultSchema.Type): string {
  const parts = result.content.map((item) =>
    item.type === 'text' && item.text != null
      ? item.text
      : `[${item.type} content omitted]`,
  );
  if (parts.length === 0 && result.structuredContent !== undefined)
    parts.push(JSON.stringify(result.structuredContent));
  return capToolResultText(parts.join('\n'));
}

/** One listed tool as a runtime tool over the server's connection. */
function mcpTool(
  server: string,
  rpc: JsonRpcConnection,
  listed: (typeof ListToolsResultSchema.Type)['tools'][number],
): ITool<Error, PluginToolServices> {
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
    // A server tool re-runs after an interruption only when its server calls
    // it read-only or idempotent: a repeat changes nothing either way.
    replay:
      listed.annotations?.readOnlyHint === true ||
      listed.annotations?.idempotentHint === true
        ? 'safe'
        : 'unsafe',
    // The call as the approval prompt shows it; the loop asks the session's
    // one approval authority before the body runs.
    guard: { command: thirdPartyCommand(describe) },
    call: (rawInput) => {
      if (!Schema.is(McpArgumentsSchema)(rawInput))
        return Effect.succeed(
          errorResult('Invalid input: the arguments must be a JSON object.'),
        );
      return rpc
        .request('tools/call', { name: listed.name, arguments: rawInput })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CallToolResultSchema)),
          Effect.map((result): ToolResult => {
            const text = resultText(result);
            return result.isError === true
              ? errorResult(text || `${listed.name} failed.`)
              : executed(text, `${server}: ${listed.name}`);
          }),
          (request) => withinDeadline(request, `MCP tool ${listed.name}`),
          Effect.catch((error) =>
            Effect.succeed(
              errorResult(
                error._tag === 'SchemaError'
                  ? `MCP server "${server}" returned a malformed result: ${error.message}`
                  : `MCP server "${server}" failed ${listed.name}: ${error.message}`,
              ),
            ),
          ),
        );
    },
  };
}

/** Spawn, initialize and list, in the caller's scope. */
const connect = Effect.fn('connect')(function* (config: McpServerConfig) {
  const handle = yield* ChildProcess.make(config.command, [...config.args], {
    env: yield* serverEnv(config),
    extendEnv: false,
    // The scope's release: SIGTERM, then SIGKILL once this has passed.
    forceKillAfter: STOP_TIMEOUT,
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
  }).pipe(
    Effect.mapError(
      (error) =>
        new McpStartError({
          message: `Failed to spawn ${config.command}: ${toErrorMessage(error)}`,
        }),
    ),
  );

  const { connection: rpc } = yield* connectJsonRpcProcess(handle, {
    framing: 'newline',
    onNotification: (method) =>
      Effect.logDebug(`[${config.name}] ${method}`).pipe(
        withLogChannel(CHANNEL),
      ),
    onRequest: (method) => (method === 'ping' ? Effect.succeed({}) : undefined),
    // A stopped run or a timed-out call stops the server's work too. The
    // protocol forbids cancelling `initialize`.
    cancel: (id, method) =>
      method === 'initialize'
        ? undefined
        : { method: 'notifications/cancelled', params: { requestId: id } },
    stderrTailLimit: STDERR_TAIL_LIMIT,
    drainTimeout: STOP_TIMEOUT,
    // What waits on the process fails with its exit code. Its stderr (which
    // may hold credentials) goes to the process log only, never into tool
    // results.
    end: Effect.fnUntraced(function* (exit, stderrTail) {
      const code = Result.getOrElse(exit, () => 'unknown' as const);
      const tail = stderrTail.trim();
      if (tail)
        yield* Effect.logWarning(
          `MCP server "${config.name}" exited (code ${code}); its stderr:\n${tail}`,
        ).pipe(withLogChannel(CHANNEL));
      return `MCP server "${config.name}" exited (code ${code})${tail ? `; its stderr is in the log (${CHANNEL})` : ''}`;
    }),
  });

  const failed = (error: { readonly message: string }) =>
    new McpStartError({ message: error.message });
  const initialized = yield* rpc
    .request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      // The app the process runs, as it names itself to model providers.
      clientInfo: {
        name: (yield* SubscriptionAccounts).client.id,
        version: '1',
      },
    })
    .pipe(Effect.mapError(failed));
  yield* decode(InitializeResultSchema, initialized, 'initialize');
  yield* rpc.notify('notifications/initialized');

  const tools = new Map<string, ITool<Error, PluginToolServices>>();
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

/**
 * Bring `config`'s server up in the caller's scope, answering its tools, or
 * its failure (with the process already stopped) and none.
 */
export const acquireMcpServer = Effect.fn('acquireMcpServer')(function* (
  config: McpServerConfig,
): Effect.fn.Return<
  LoadedPluginTools,
  never,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | SubscriptionAccounts
> {
  const scope = yield* Scope.fork(yield* Effect.scope, 'sequential');
  const result = yield* connect(config).pipe(
    Effect.timeoutOrElse({
      duration: START_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new McpStartError({
            message: `No answer within ${Duration.format(START_TIMEOUT)}`,
          }),
        ),
    }),
    Scope.provide(scope),
    Effect.result,
  );
  if (result._tag === 'Success') return { tools: result.success };
  yield* Scope.close(scope, Exit.void);
  const failure = `MCP server "${config.name}" did not start: ${result.failure.message}`;
  yield* Effect.logWarning(failure).pipe(withLogChannel(CHANNEL));
  return { tools: new Map(), failure };
});

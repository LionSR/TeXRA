/**
 * One stdio MCP server, brought up in a scope: spawned with a scrubbed
 * environment, connected through effect/ai's `McpClient`, its tools listed,
 * and stopped (stdin closed, then SIGTERM, then SIGKILL) when the scope
 * closes. The scope is its project's catalog entry for its spec, revision
 * and project variables (`ToolCatalog`), so the process lives while some
 * open run or step of that project holds it and for the catalog's idle time
 * after the last one lets go (`projectServers`, `./mcpConfig`).
 *
 * The client speaks MCP 2025-11-25 and nothing older: a server that answers
 * an earlier revision does not start, and its failure names both. Each
 * listed tool becomes a runtime tool named `mcp__<server>__<tool>` whose
 * JSON Schema passes through as its parameters. Every call is
 * approval-gated through the loop's one guard (the session's bash approval),
 * is never parallel-safe, is replay-safe only when its server marks it
 * read-only or idempotent (any other interrupted call finishes as outcome
 * unknown on resume, and the model decides), and is bounded by the
 * third-party deadline (`@tools/thirdPartyTool`) and an output cap. An
 * interrupted call tells the server it is cancelled.
 *
 * A server that fails to spawn, initialize or list answers its failure and
 * no tools, with a warning in the process log; the run that names it shows
 * the failure in its transcript.
 */
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Schema,
  Scope,
  Stream,
} from 'effect';
import {
  McpClient,
  type McpClientError,
  McpProtocol,
  type McpSchema,
} from 'effect/ai';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { SubscriptionAccounts } from '@texra-ai/llm/node';

import type { ITool } from '@tools/core/ToolTypes';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import { capToolResultText } from '@shared/toolResultText';
import type { McpServerConfig } from '@common/plugins/mcpServers';
import { withLogChannel } from '@logger/effectLog';
import type { ToolResult } from '@shared/schemas';
import { MCP_TOOL_PREFIX } from '@shared/tools/toolDisplayName';
import { errorResult, executed } from '@tools/core/result';
import { thirdPartyCommand, withinDeadline } from '@tools/thirdPartyTool';
import { environment, ProjectEnvironment } from '@utils/system/nodeWorkspace';
import { envNameKey, withCommandDirs } from '@utils/system/platformPaths';
import { truncatedHexId } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { appendTail } from '@utils/text/appendTail';

import type { LoadedPluginTools } from './mcpConfig';

const CHANNEL = 'mcp';

/** The revision the client speaks. A server answering another one fails
 *  the start; the official TypeScript SDK answers it from 1.25 on. */
const PROTOCOL = McpProtocol.v2025_11_25;
const START_TIMEOUT = Duration.seconds(30);
/** How long the process group has after SIGTERM before SIGKILL, and how
 *  long an exited server's stderr may take to finish draining. */
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

/** A client failure as one line: the client's own wording, then its cause
 *  (the spawn error, the field a listing failed to decode). */
function clientMessage(error: McpClientError.McpClientError): string {
  const { reason } = error;
  const cause = 'cause' in reason ? reason.cause : undefined;
  return cause === undefined
    ? reason.message
    : `${reason.message}: ${toErrorMessage(cause)}`;
}

/** The text a call result carries, within the cap every tool result takes:
 *  a server is another program, so its result is cut before it is stored. */
function resultText(result: McpSchema.CallToolResult): string {
  const parts = result.content.map((item) =>
    item.type === 'text' ? item.text : `[${item.type} content omitted]`,
  );
  if (parts.length === 0 && result.structuredContent !== undefined)
    parts.push(JSON.stringify(result.structuredContent));
  return capToolResultText(parts.join('\n'));
}

/** One listed tool as a runtime tool over the server's connection. */
function mcpTool(
  server: string,
  client: McpClient.McpClient,
  listed: McpSchema.Tool,
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
      parameters: listed.inputSchema,
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
      return client.callTool({ tool: listed, arguments: rawInput }).pipe(
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
              `MCP server "${server}" failed ${listed.name}: ${clientMessage(error)}`,
            ),
          ),
        ),
      );
    },
  };
}

/**
 * The spawner the client starts `server` with. The client drains a server's
 * stderr and drops it; this one keeps its tail and logs it once the process
 * exits, to the process log only, never into tool results, since it may hold
 * credentials. `stopping` marks a stop the scope makes, which logs nothing:
 * the client's own close (stdin, then signals) is the exit there.
 */
const stderrLogging = Effect.fn('stderrLogging')(function* (server: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let stopped = false;
  const stopping = Effect.sync(() => {
    stopped = true;
  });
  const logging = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const drained = yield* Deferred.make<void>();
      let tail = '';
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const code = yield* Effect.orElseSucceed(
            handle.exitCode,
            () => 'unknown' as const,
          );
          yield* Deferred.await(drained).pipe(
            Effect.timeoutOption(STOP_TIMEOUT),
          );
          if (!stopped && tail.trim())
            yield* Effect.logWarning(
              `MCP server "${server}" exited (code ${code}); its stderr:\n${tail.trim()}`,
            ).pipe(withLogChannel(CHANNEL));
        }),
      );
      return ChildProcessSpawner.makeHandle({
        ...handle,
        stderr: handle.stderr.pipe(
          Stream.decodeText(),
          Stream.tap((chunk) =>
            Effect.sync(() => {
              tail = appendTail(tail, chunk, STDERR_TAIL_LIMIT);
            }),
          ),
          Stream.encodeText,
          Stream.ensuring(Deferred.succeed(drained, undefined)),
        ),
      });
    }),
  );
  return { spawner: logging, stopping };
});

/**
 * `transport` with the revision a server answers `initialize` with kept in
 * `answered`: the client refuses another revision without saying which.
 */
const recordingRevision = (transport: McpClient.Transport) => {
  let answered: string | undefined;
  const recording: McpClient.Transport = {
    ...transport,
    request: (message, tool) =>
      transport.request(message, tool).pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            const result: unknown = response.result;
            if (
              message.method === 'initialize' &&
              typeof result === 'object' &&
              result !== null &&
              'protocolVersion' in result &&
              typeof result.protocolVersion === 'string'
            )
              answered = result.protocolVersion;
          }),
        ),
      ),
  };
  return { transport: recording, answered: () => answered };
};

/** Spawn, initialize and list, in the caller's scope. */
const connect = Effect.fn('connect')(function* (config: McpServerConfig) {
  const stderr = yield* stderrLogging(config.name);
  const { transport, answered } = recordingRevision(
    yield* McpClient.stdio({
      command: ChildProcess.make(config.command, [...config.args], {
        env: yield* serverEnv(config),
        extendEnv: false,
        // After the client's own close: SIGTERM to the process group, then
        // SIGKILL once this has passed.
        forceKillAfter: STOP_TIMEOUT,
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      }),
      protocol: PROTOCOL,
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        stderr.spawner,
      ),
    ),
  );
  // Runs before the transport's close, which ends the process.
  yield* Effect.addFinalizer(() => stderr.stopping);
  const client = yield* McpClient.make({
    // The app the process runs, as it names itself to model providers.
    name: (yield* SubscriptionAccounts).client.id,
    version: '1',
  }).pipe(
    Effect.provideService(McpClient.Transport, transport),
    // At initialization the client refuses only a server that answered
    // another revision; for a stdio server that means an older MCP SDK.
    Effect.mapError((error) =>
      error.reason._tag === 'UnsupportedError'
        ? new McpStartError({
            message: `it answered MCP revision ${answered() ?? '(none)'}, but MCP ${PROTOCOL.protocolVersion} is required; update the server (its MCP SDK is older)`,
          })
        : error,
    ),
  );
  const tools = new Map<string, ITool<Error, PluginToolServices>>();
  // A server that declares no tools capability lists none.
  for (const listed of yield* client.listTools()) {
    const tool = mcpTool(config.name, client, listed);
    tools.set(tool.definition.name, tool);
  }
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
    Effect.mapError((error) =>
      error._tag === 'McpStartError'
        ? error
        : new McpStartError({ message: clientMessage(error) }),
    ),
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
    Effect.result,
  );
  if (result._tag === 'Success') return { tools: result.success };
  yield* Scope.close(scope, Exit.void);
  const failure = `MCP server "${config.name}" did not start: ${result.failure.message}`;
  yield* Effect.logWarning(failure).pipe(withLogChannel(CHANNEL));
  return { tools: new Map(), failure };
});

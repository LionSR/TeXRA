import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { defineCommand, runCommand, showUsage, type CommandDef } from 'citty';

import { getAgent, getVisibleAgents, loadAgents } from '@agent/index';
import {
  DEFAULT_AGENT_MODEL,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { executeAgent } from '@agent/runtime/executeAgent';
import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import { isOAuthProvider } from '@auth/sharedConfig';
import { toErrorMessage } from '@common/errors/errorMessage';
import { isNonEmptyString } from '@utils/core/stringCore';

import {
  buildCliContext,
  CliUsageError,
  CLI_OUTPUT_FORMATS,
  readCliAmbientState,
  readCliArgv,
  readCliVersion,
  type CliContext,
  type CliOutputFormat,
} from '../runtime/cliContext';
import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from '../runtime/approvalPolicy';
import {
  hasCliApprovalDenied,
  installCliApprovalHandlers,
} from '../runtime/approvalAdapter';
import { initCliPlatform } from '../runtime/initPlatform';
import { getCliModelAccessList } from '../runtime/modelAccess';
import { createCliRuntimeHost } from '../runtime/runtimeHost';
import { CliExitCode } from '../runtime/exitCodes';
import {
  getCliAuthProvider,
  getCliAuthProfile,
  signInCliSupabase,
  signOutCliSupabase,
} from '../runtime/supabaseAuth';
import { pickGlobalArgs, type ParsedGlobalArgs } from '../runtime/globalArgs';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';

// One CLI invocation per process — module-level pending exit code is the
// simplest way to surface handler exit codes back to `bin/texra.ts` after
// `runCommand` returns. citty's `ctx.data` would also work but is `any`-typed.
let pendingExitCode: number = CliExitCode.Success;

function setExitCode(code: number): void {
  pendingExitCode = code;
}

async function contextFromArgs(args: ParsedGlobalArgs): Promise<CliContext> {
  return buildCliContext({ globalArgs: pickGlobalArgs(args) });
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Single source of truth for the four global flags accepted by every TeXRA
 * subcommand. `as const` + spread would lose literal-type narrowing (citty's
 * `ArgsDef` rejects `readonly string[]`), so each enum's `options` is
 * explicitly typed as a mutable literal tuple — assignable to `string[]` and
 * narrow enough for `defineCommand<const T>` to expose the per-option literal
 * on `ctx.args[...]`. Adding a new global flag is a one-line change here.
 */
const GLOBAL_ARGS: {
  print: { type: 'boolean'; alias: 'p' };
  cwd: { type: 'string' };
  'output-format': {
    type: 'enum';
    options: CliOutputFormat[];
    default: 'text';
  };
  'approval-policy': {
    type: 'enum';
    options: CliApprovalPolicy[];
    default: 'never';
  };
} = {
  print: { type: 'boolean', alias: 'p' },
  cwd: { type: 'string' },
  'output-format': {
    type: 'enum',
    options: [...CLI_OUTPUT_FORMATS],
    default: 'text',
  },
  'approval-policy': {
    type: 'enum',
    options: [...CLI_APPROVAL_POLICIES],
    default: 'never',
  },
};

const agentsListCommand = defineCommand({
  meta: { name: 'list', description: 'List available agents' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await listAgents(context));
  },
});

async function listAgents(context: CliContext): Promise<number> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });
  await loadAgents({ includeRemote: false });
  const agents = [AgentCategory.Workflow, AgentCategory.ToolUse].flatMap(
    (category) =>
      getVisibleAgents(category).map((agent) => ({ ...agent, category })),
  );

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(agents, null, 2));
    return CliExitCode.Success;
  }

  if (context.outputFormat === 'ndjson') {
    const ts = new Date().toISOString();
    for (const agent of agents) {
      writeNdjsonStdout({ kind: 'agent', ts, agent });
    }
    return CliExitCode.Success;
  }

  for (const agent of agents) {
    writeTextStdout(
      `${agent.category}\t${agent.name}\t${agent.description ?? ''}`,
    );
  }
  return CliExitCode.Success;
}

const agentsCommand = defineCommand({
  meta: { name: 'agents', description: 'Inspect TeXRA agents' },
  subCommands: { list: agentsListCommand },
});

const modelsListCommand = defineCommand({
  meta: { name: 'list', description: 'List available models' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await listModels(context));
  },
});

async function listModels(context: CliContext): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const modelAccess = await getCliModelAccessList();

  if (context.outputFormat === 'json') {
    writeTextStdout(
      JSON.stringify(
        modelAccess.map(({ model }) => model),
        null,
        2,
      ),
    );
    return CliExitCode.Success;
  }

  if (context.outputFormat === 'ndjson') {
    const ts = new Date().toISOString();
    for (const { model } of modelAccess) {
      writeNdjsonStdout({ kind: 'model', ts, model });
    }
    return CliExitCode.Success;
  }

  for (const { model, status } of modelAccess) {
    writeTextStdout(`${model.value}\t${model.label}\t${status}`);
  }
  return CliExitCode.Success;
}

const modelsCommand = defineCommand({
  meta: { name: 'models', description: 'Inspect TeXRA models' },
  subCommands: { list: modelsListCommand },
});

const versionCommand = defineCommand({
  meta: { name: 'version', description: 'Print the CLI version' },
  async run() {
    writeTextStdout(await readCliVersion());
    setExitCode(CliExitCode.Success);
  },
});

const loginCommand = defineCommand({
  meta: { name: 'login', description: 'Sign in to TeXRA for included access' },
  args: {
    ...GLOBAL_ARGS,
    provider: {
      type: 'string',
      description:
        'OAuth provider: github or google (alternative to positional)',
    },
    providerArg: {
      type: 'positional',
      required: false,
      description: 'OAuth provider: github or google',
    },
    'no-browser': {
      type: 'boolean',
      description: 'Print the sign-in URL instead of opening a browser',
    },
    'select-account': {
      type: 'boolean',
      description:
        'Ask the OAuth provider to show account selection when supported',
    },
    'login-hint': {
      type: 'string',
      description:
        'Suggest a specific provider account, such as a GitHub username or Google email',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const positional = optString(ctx.args.providerArg);
    const flag = optString(ctx.args.provider);
    const provider = resolveLoginProvider(positional, flag);
    setExitCode(
      await runLogin(context, {
        provider,
        noBrowser: ctx.args['no-browser'] === true,
        selectAccount: ctx.args['select-account'] === true,
        loginHint: optString(ctx.args['login-hint']),
      }),
    );
  },
});

export function resolveLoginProvider(
  positional: string | undefined,
  flag: string | undefined,
): string {
  if (isNonEmptyString(flag)) return flag.trim();
  if (isNonEmptyString(positional)) return positional.trim();
  return DEFAULT_OAUTH_PROVIDER;
}

interface LoginInit {
  readonly provider: string;
  readonly noBrowser: boolean;
  readonly selectAccount: boolean;
  readonly loginHint?: string;
}

async function runLogin(context: CliContext, init: LoginInit): Promise<number> {
  if (!isOAuthProvider(init.provider)) {
    writeTextStderr(
      `Unsupported provider: ${init.provider}. Expected github or google.`,
    );
    return CliExitCode.Usage;
  }
  await initCliPlatform({ ...context, quietLogs: true });
  if (context.outputFormat === 'text' && !init.noBrowser) {
    writeTextStdout(`Opening browser for TeXRA ${init.provider} sign-in...`);
  }
  let session: Awaited<ReturnType<typeof signInCliSupabase>>;
  try {
    session = await signInCliSupabase({
      provider: init.provider,
      openBrowser: !init.noBrowser,
      selectAccount: init.selectAccount,
      loginHint: init.loginHint,
      manualBrowserHint: 'texra login --no-browser',
      onAuthUrl: (url) => {
        if (init.noBrowser) {
          const writeAuthUrl =
            context.outputFormat === 'text' ? writeTextStdout : writeTextStderr;
          writeAuthUrl(`Open this URL to sign in:\n${url}`);
        }
      },
    });
  } catch (error) {
    writeTextStderr(toErrorMessage(error));
    return CliExitCode.ModelOrNetworkError;
  }

  if (context.outputFormat === 'json') {
    writeTextStdout(
      JSON.stringify(
        {
          authenticated: true,
          account: session.account,
          expiresAt: new Date(session.expiresAt).toISOString(),
        },
        null,
        2,
      ),
    );
  } else if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'auth',
      ts: new Date().toISOString(),
      authenticated: true,
      account: session.account,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  } else {
    writeTextStdout(`Signed in as ${session.account.label}.`);
  }
  return CliExitCode.Success;
}

const logoutCommand = defineCommand({
  meta: { name: 'logout', description: 'Sign out of TeXRA' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    await initCliPlatform({ ...context, quietLogs: true });
    try {
      await signOutCliSupabase();
    } catch (error) {
      writeTextStderr(toErrorMessage(error));
      setExitCode(CliExitCode.ModelOrNetworkError);
      return;
    }

    if (context.outputFormat === 'json') {
      writeTextStdout(JSON.stringify({ authenticated: false }, null, 2));
    } else if (context.outputFormat === 'ndjson') {
      writeNdjsonStdout({
        kind: 'auth',
        ts: new Date().toISOString(),
        authenticated: false,
      });
    } else {
      writeTextStdout('Signed out.');
    }
    setExitCode(CliExitCode.Success);
  },
});

const authStatusCommand = defineCommand({
  meta: { name: 'status', description: 'Show TeXRA sign-in status' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    let profile: Awaited<ReturnType<typeof getCliAuthProfile>>;
    try {
      await initCliPlatform({ ...context, quietLogs: true });
      profile = await getCliAuthProfile();
    } catch (error) {
      writeTextStderr(toErrorMessage(error));
      setExitCode(CliExitCode.ModelOrNetworkError);
      return;
    }

    if (context.outputFormat === 'json') {
      writeTextStdout(JSON.stringify(profile, null, 2));
    } else if (context.outputFormat === 'ndjson') {
      writeNdjsonStdout({
        kind: 'auth-status',
        ts: new Date().toISOString(),
        ...profile,
      });
    } else if (profile.authenticated) {
      writeTextStdout(
        `Signed in as ${profile.accountLabel ?? 'unknown'} (${profile.tier ?? 'unknown'}).`,
      );
    } else {
      writeTextStdout('Not signed in.');
    }
    setExitCode(CliExitCode.Success);
  },
});

const authCommand = defineCommand({
  meta: { name: 'auth', description: 'Authentication commands' },
  subCommands: { status: authStatusCommand },
});

const runWorkflowCommand = defineCommand({
  meta: { name: 'run', description: 'Run a workflow agent' },
  args: {
    ...GLOBAL_ARGS,
    agent: {
      type: 'positional',
      required: true,
      description: 'Workflow agent name',
    },
    input: {
      type: 'string',
      alias: 'i',
      required: true,
      description: 'Input file passed to the workflow agent',
    },
    output: { type: 'string', description: 'Output file path' },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Model for the agent',
    },
    instruction: {
      type: 'string',
      description: 'Instruction passed to the workflow agent',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(
      await runWorkflowAgent(context, {
        agent: ctx.args.agent,
        input: ctx.args.input,
        output: optString(ctx.args.output),
        model: optString(ctx.args.model),
        instruction: optString(ctx.args.instruction) ?? '',
      }),
    );
  },
});

type ExecuteAgentResult = Awaited<ReturnType<typeof executeAgent>>;

interface WorkflowRunInit {
  readonly agent: string;
  readonly input: string;
  readonly output?: string;
  readonly model?: string;
  readonly instruction: string;
}

async function resolveWorkflowOutput(
  outputFile: string | undefined,
  result: ExecuteAgentResult,
  context: CliContext,
): Promise<{
  copiedOutput: string | undefined;
  displayResult: ExecuteAgentResult;
}> {
  if (!outputFile || result.category !== AgentCategory.Workflow) {
    return { copiedOutput: undefined, displayResult: result };
  }

  const finalOutputIndex = result.outputs.length - 1;
  const finalOutput = result.outputs[finalOutputIndex];
  if (!finalOutput) return { copiedOutput: undefined, displayResult: result };

  const targetPath = path.isAbsolute(outputFile)
    ? outputFile
    : path.join(context.cwd, outputFile);
  if (path.resolve(finalOutput.absolutePath) !== path.resolve(targetPath)) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(finalOutput.absolutePath, targetPath);
  }

  const displayResult: ExecuteAgentResult = {
    ...result,
    outputs: result.outputs.map((output, index) =>
      index === finalOutputIndex
        ? { ...output, absolutePath: targetPath }
        : output,
    ),
  };
  return { copiedOutput: targetPath, displayResult };
}

async function runWorkflowAgent(
  context: CliContext,
  init: WorkflowRunInit,
): Promise<number> {
  const model = init.model?.trim() || DEFAULT_AGENT_MODEL;
  const runContext: CliContext = {
    ...context,
    helperModel: model,
    quietLogs: true,
  };
  await initCliPlatform(runContext);
  installCliApprovalHandlers(runContext);
  await loadAgents({ includeRemote: false });
  if (
    !getAgent(init.agent) ||
    (await shouldHonorRemoteAgentPriority(init.agent))
  ) {
    await loadAgents();
  }

  const modelOutputFile =
    init.output && path.isAbsolute(init.output)
      ? path.basename(init.output)
      : init.output;
  const config: AgentConfigPayload = {
    agent: init.agent,
    model,
    inputFiles: [init.input],
    outputFiles: modelOutputFile ? [modelOutputFile] : [],
    instruction: init.instruction,
    workingDirectory: runContext.cwd,
  };

  const runtimeHost = createCliRuntimeHost(runContext);
  let result: ExecuteAgentResult;
  try {
    result = await executeAgent(config, undefined, { runtimeHost });
  } finally {
    await runtimeHost.close();
  }

  const { copiedOutput, displayResult } = await resolveWorkflowOutput(
    init.output,
    result,
    runContext,
  );

  if (runContext.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(displayResult, null, 2));
  } else if (runContext.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'result',
      ts: new Date().toISOString(),
      result: displayResult,
    });
  } else if (result.category === AgentCategory.Workflow) {
    const finalOutput = result.outputs.at(-1);
    writeTextStdout(
      finalOutput?.relativePath ??
        copiedOutput ??
        finalOutput?.absolutePath ??
        result.status,
    );
  } else {
    writeTextStdout(result.status);
  }

  if (result.status !== 'error') return CliExitCode.Success;
  return hasCliApprovalDenied(runContext)
    ? CliExitCode.ApprovalDenied
    : CliExitCode.AgentError;
}

async function shouldHonorRemoteAgentPriority(
  agentName: string,
): Promise<boolean> {
  if (agentName.includes(':')) return false;
  return getCliAuthProvider().isAuthenticated();
}

const chatCommand = defineCommand({
  meta: { name: 'chat', description: 'Interactive tool-use chat session' },
  args: {
    ...GLOBAL_ARGS,
    agent: { type: 'string', description: 'Tool-use agent for the session' },
    model: { type: 'string', alias: 'm', description: 'Model for the session' },
    'tool-display': {
      type: 'enum',
      options: ['grouped', 'minimal', 'hidden'],
      description: 'Deprecated: accepted for compatibility and ignored',
    },
    tui: {
      type: 'boolean',
      description: 'Deprecated: chat always uses the Ink TUI',
    },
    'legacy-renderer': {
      type: 'boolean',
      description: 'Deprecated: the legacy renderer was retired',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    if (
      ctx.args.tui !== undefined ||
      ctx.args['legacy-renderer'] !== undefined ||
      ctx.args['tool-display'] !== undefined
    ) {
      writeTextStderr(
        'texra chat: --tui/--no-tui, --legacy-renderer, and --tool-display are deprecated and ignored; chat now always uses the Ink TUI.',
      );
    }
    const { runChat } = await import('../chat/tui/runChatTui');
    const result = await runChat(context, {
      agentOverride: optString(ctx.args.agent),
      modelOverride: optString(ctx.args.model),
    });
    setExitCode(result.exitCode);
  },
});

const helpCommand = defineCommand({
  meta: { name: 'help', description: 'Show TeXRA CLI usage' },
  async run() {
    await showUsage(rootCommand);
  },
});

const rootCommand = defineCommand({
  // Citty's `runMain` reads `meta.version` for `--version`/`-v`. We resolve
  // lazily so the bundled binary picks up the version emitted by the build
  // (see `readCliVersion` in cliContext.ts).
  meta: async () => ({
    name: 'texra',
    description: 'TeXRA CLI — AI LaTeX research assistant',
    version: await readCliVersion(),
  }),
  // Global flags are duplicated here so citty's `findSubCommandIndex` knows
  // which leading flags take values (otherwise `texra --output-format ndjson
  // agents list` mis-detects `ndjson` as the subcommand). The actual parsing
  // happens on each subcommand; root only acts as a routing layer.
  args: {
    ...GLOBAL_ARGS,
  },
  subCommands: {
    chat: chatCommand,
    run: runWorkflowCommand,
    agents: agentsCommand,
    models: modelsCommand,
    login: loginCommand,
    logout: logoutCommand,
    auth: authCommand,
    version: versionCommand,
    help: helpCommand,
  },
  // No subcommand on bare `texra`: dispatch to `chat` when both TTYs are
  // interactive (per docs/prd/cli-tui-ink/10-architecture.md#entrypoint-default);
  // fall through to the synthetic `help` subcommand otherwise.
  default: () => {
    const ambient = readCliAmbientState();
    return ambient.stdinIsTty && ambient.stdoutIsTty ? 'chat' : 'help';
  },
});

// Derived from `GLOBAL_ARGS` so adding/renaming a global flag in one place
// flows through to `reorderGlobalFlags` automatically.
const GLOBAL_VALUE_FLAGS = new Set<string>(
  Object.entries(GLOBAL_ARGS)
    .filter(([, def]) => def.type !== 'boolean')
    .map(([name]) => `--${name}`),
);
const GLOBAL_BOOL_FLAGS = new Set<string>(
  Object.entries(GLOBAL_ARGS).flatMap(([name, def]) => {
    if (def.type !== 'boolean') return [];
    const long = `--${name}`;
    const alias = 'alias' in def ? def.alias : undefined;
    return alias ? [long, `-${alias}`] : [long];
  }),
);

/**
 * Citty's runCommand consumes args at the root and passes only `rawArgs.slice(
 * subCommandIndex + 1)` to the matched subcommand. That means global flags
 * appearing before the subcommand name (`texra --output-format ndjson agents
 * list`) never reach the subcommand's parser. We sidestep that by lifting
 * leading global flags to the end of rawArgs so they live inside the
 * subcommand's slice. No-op when there is no subcommand or no leading globals.
 */
export function reorderGlobalFlags(rawArgs: readonly string[]): string[] {
  const leadingGlobals: string[] = [];
  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (arg === undefined) break;
    if (!arg.startsWith('-')) break;
    if (arg === '--') break;
    const inline = arg.includes('=');
    const baseFlag = inline ? arg.slice(0, arg.indexOf('=')) : arg;
    if (GLOBAL_BOOL_FLAGS.has(baseFlag)) {
      leadingGlobals.push(arg);
      i += 1;
      continue;
    }
    if (GLOBAL_VALUE_FLAGS.has(baseFlag)) {
      leadingGlobals.push(arg);
      i += 1;
      if (!inline) {
        const value = rawArgs[i];
        if (value !== undefined) {
          leadingGlobals.push(value);
          i += 1;
        }
      }
      continue;
    }
    // Unknown leading flag — leave the rest intact so runMain can surface
    // `--help`, `--version`, or an unknown-flag error.
    return [...rawArgs];
  }
  if (i >= rawArgs.length || leadingGlobals.length === 0) {
    return [...rawArgs];
  }
  return [...rawArgs.slice(i), ...leadingGlobals];
}

export function normalizeRootShortcuts(rawArgs: readonly string[]): string[] {
  const leadingGlobals: string[] = [];
  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (arg === undefined) break;
    if (!arg.startsWith('-')) break;
    if (arg === '--') break;
    const inline = arg.includes('=');
    const baseFlag = inline ? arg.slice(0, arg.indexOf('=')) : arg;
    if (GLOBAL_BOOL_FLAGS.has(baseFlag)) {
      leadingGlobals.push(arg);
      i += 1;
      continue;
    }
    if (GLOBAL_VALUE_FLAGS.has(baseFlag)) {
      leadingGlobals.push(arg);
      i += 1;
      if (!inline) {
        const value = rawArgs[i];
        if (value !== undefined) {
          leadingGlobals.push(value);
          i += 1;
        }
      }
      continue;
    }
    break;
  }

  if (rawArgs[i] !== '--logout') return [...rawArgs];
  return ['logout', ...leadingGlobals, ...rawArgs.slice(i + 1)];
}

function isCliError(error: unknown): error is Error & { code?: string } {
  return (
    error instanceof Error &&
    error.name === 'CLIError' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/**
 * Walk `rawArgs` positional-by-positional through the subcommand tree to find
 * the deepest matched command. Used to scope `--help` to the subcommand the
 * user typed rather than always showing root-level usage.
 *
 * Stops at the first positional that doesn't match a child subcommand. Returns
 * a tuple of `[matchedCommand, parentCommandOrUndefined]` so `showUsage` can
 * render the same breadcrumb citty's own resolver produces.
 */
// Citty's `CommandDef<T>` is invariant in `T` (T appears in both `run` and
// `setup` parameters), so a narrower const-inferred command isn't assignable
// to the parent type. We treat the subcommand tree as `CommandDef<any>` while
// walking it; this matches citty's own `subCommands` shape and lets
// `showUsage` accept either width via cast at the call site.
type AnyCommand = CommandDef<any>;

async function resolveDeepestSubCommand(
  cmd: AnyCommand,
  rawArgs: readonly string[],
  parent?: AnyCommand,
): Promise<[AnyCommand, AnyCommand | undefined]> {
  const rawSubs = cmd.subCommands;
  const subCommands =
    typeof rawSubs === 'function'
      ? await (rawSubs as () => Promise<Record<string, AnyCommand>>)()
      : ((await rawSubs) as Record<string, AnyCommand> | undefined);
  if (!subCommands) return [cmd, parent];
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === undefined) break;
    if (token.startsWith('-')) continue;
    const next = subCommands[token];
    if (next) return resolveDeepestSubCommand(next, rawArgs.slice(i + 1), cmd);
    break;
  }
  return [cmd, parent];
}

/**
 * Re-implement the surface citty's `runMain` provides — `--help` / `--version`
 * detection plus error handling around `runCommand` — so usage errors (missing
 * required flag, unknown subcommand, invalid enum value) preserve our
 * canonical `CliExitCode.Usage` (2) instead of citty's hard-coded `exit(1)`.
 */
export async function runCli(
  argv?: readonly string[],
): Promise<{ exitCode: number }> {
  pendingExitCode = CliExitCode.Success;
  const rawArgs = reorderGlobalFlags(
    normalizeRootShortcuts(argv ? [...argv] : readCliArgv()),
  );

  // `--help` / `-h` anywhere prints usage for the deepest matched subcommand
  // (e.g. `texra agents list --help` → list-level usage), mirroring citty's
  // own `runMain` behavior without inheriting its `exit(1)` for usage errors.
  if (rawArgs.some((arg) => arg === '--help' || arg === '-h')) {
    const [target, parent] = await resolveDeepestSubCommand(
      rootCommand,
      rawArgs,
    );
    await showUsage(target, parent);
    return { exitCode: CliExitCode.Success };
  }
  if (
    rawArgs.length === 1 &&
    (rawArgs[0] === '--version' || rawArgs[0] === '-v')
  ) {
    writeTextStdout(await readCliVersion());
    return { exitCode: CliExitCode.Success };
  }

  try {
    await runCommand(rootCommand, { rawArgs });
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeTextStderr(error.message);
      return { exitCode: CliExitCode.Usage };
    }
    if (isCliError(error)) {
      const [target, parent] = await resolveDeepestSubCommand(
        rootCommand,
        rawArgs,
      );
      await showUsage(target, parent);
      writeTextStderr(error.message);
      return { exitCode: CliExitCode.Usage };
    }
    throw error;
  }
  return { exitCode: pendingExitCode };
}

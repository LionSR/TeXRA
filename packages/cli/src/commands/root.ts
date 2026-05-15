// Standard library imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { defineCommand, runMain } from 'citty';

// Local imports - agent and model surfaces
import { getVisibleAgents, loadAgents } from '@agent/index';
import {
  DEFAULT_AGENT_MODEL,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import { isOAuthProvider } from '@auth/sharedConfig';
import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import { toErrorMessage } from '@common/errors/errorMessage';

// Local imports - CLI runtime
import {
  buildCliContext,
  CliUsageError,
  readCliAmbientState,
  readCliArgv,
  readCliVersion,
  type CliContext,
} from '../runtime/cliContext';
import {
  hasCliApprovalDenied,
  installCliApprovalHandlers,
} from '../runtime/approvalAdapter';
import { initCliPlatform } from '../runtime/initPlatform';
import { getCliModelAccessList } from '../runtime/modelAccess';
import { createCliRuntimeHost } from '../runtime/runtimeHost';
import { CliExitCode } from '../runtime/exitCodes';
import {
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
// simplest typed-throw alternative for surfacing handler exit codes back to
// `bin/texra.ts` after `runCommand` returns.
let pendingExitCode: number = CliExitCode.Success;

function setExitCode(code: number): void {
  pendingExitCode = code;
}

/**
 * Adapt citty-parsed args into the `CliContext` shape consumed by the rest of
 * the CLI. Handlers call this once at entry — no further global-flag re-parsing.
 */
async function contextFromArgs(args: ParsedGlobalArgs): Promise<CliContext> {
  return buildCliContext({ globalArgs: pickGlobalArgs(args) });
}

// ---------------------------------------------------------------------------
// agents list
// ---------------------------------------------------------------------------

const agentsListCommand = defineCommand({
  meta: { name: 'list', description: 'List available agents' },
  args: {
    print: { type: 'boolean', alias: 'p' },
    cwd: { type: 'string' },
    'output-format': {
      type: 'enum',
      options: ['text', 'json', 'ndjson'],
      default: 'text',
    },
    'approval-policy': {
      type: 'enum',
      options: ['never', 'ask', 'yolo'],
      default: 'never',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await listAgents(context));
  },
});

async function listAgents(context: CliContext): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  await loadAgents();
  const agents = [
    ...getVisibleAgents('workflow').map((agent) => ({
      ...agent,
      category: 'workflow' as const,
    })),
    ...getVisibleAgents('toolUse').map((agent) => ({
      ...agent,
      category: 'toolUse' as const,
    })),
  ];

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

// ---------------------------------------------------------------------------
// models list
// ---------------------------------------------------------------------------

const modelsListCommand = defineCommand({
  meta: { name: 'list', description: 'List available models' },
  args: {
    print: { type: 'boolean', alias: 'p' },
    cwd: { type: 'string' },
    'output-format': {
      type: 'enum',
      options: ['text', 'json', 'ndjson'],
      default: 'text',
    },
    'approval-policy': {
      type: 'enum',
      options: ['never', 'ask', 'yolo'],
      default: 'never',
    },
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

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

const versionCommand = defineCommand({
  meta: { name: 'version', description: 'Print the CLI version' },
  async run() {
    const context = await buildCliContext({
      globalArgs: {
        outputFormat: 'text',
        approvalPolicy: 'never',
      },
    });
    writeTextStdout(context.version);
    setExitCode(CliExitCode.Success);
  },
});

// ---------------------------------------------------------------------------
// login / logout / auth status
// ---------------------------------------------------------------------------

const loginCommand = defineCommand({
  meta: { name: 'login', description: 'Sign in to TeXRA for included access' },
  args: {
    print: { type: 'boolean', alias: 'p' },
    cwd: { type: 'string' },
    'output-format': {
      type: 'enum',
      options: ['text', 'json', 'ndjson'],
      default: 'text',
    },
    'approval-policy': {
      type: 'enum',
      options: ['never', 'ask', 'yolo'],
      default: 'never',
    },
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
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const positional =
      typeof ctx.args.providerArg === 'string'
        ? ctx.args.providerArg
        : undefined;
    const flag =
      typeof ctx.args.provider === 'string' ? ctx.args.provider : undefined;
    const provider = resolveLoginProvider(positional, flag);
    setExitCode(
      await runLogin(context, {
        provider,
        noBrowser: ctx.args['no-browser'] === true,
      }),
    );
  },
});

export function resolveLoginProvider(
  positional: string | undefined,
  flag: string | undefined,
): string {
  if (flag && flag.trim().length > 0) return flag.trim();
  if (positional && positional.trim().length > 0) return positional.trim();
  return DEFAULT_OAUTH_PROVIDER;
}

interface LoginInit {
  readonly provider: string;
  readonly noBrowser: boolean;
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
    print: { type: 'boolean', alias: 'p' },
    cwd: { type: 'string' },
    'output-format': {
      type: 'enum',
      options: ['text', 'json', 'ndjson'],
      default: 'text',
    },
    'approval-policy': {
      type: 'enum',
      options: ['never', 'ask', 'yolo'],
      default: 'never',
    },
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
    print: { type: 'boolean', alias: 'p' },
    cwd: { type: 'string' },
    'output-format': {
      type: 'enum',
      options: ['text', 'json', 'ndjson'],
      default: 'text',
    },
    'approval-policy': {
      type: 'enum',
      options: ['never', 'ask', 'yolo'],
      default: 'never',
    },
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

// ---------------------------------------------------------------------------
// run (workflow agent)
// ---------------------------------------------------------------------------

const runWorkflowCommand = defineCommand({
  meta: { name: 'run', description: 'Run a workflow agent' },
  args: {
    print: { type: 'boolean', alias: 'p' },
    cwd: { type: 'string' },
    'output-format': {
      type: 'enum',
      options: ['text', 'json', 'ndjson'],
      default: 'text',
    },
    'approval-policy': {
      type: 'enum',
      options: ['never', 'ask', 'yolo'],
      default: 'never',
    },
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
        output:
          typeof ctx.args.output === 'string' ? ctx.args.output : undefined,
        model: typeof ctx.args.model === 'string' ? ctx.args.model : undefined,
        instruction:
          typeof ctx.args.instruction === 'string' ? ctx.args.instruction : '',
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
  if (!outputFile || result.category !== 'workflow') {
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
  await loadAgents();

  const modelOutputFile =
    init.output && path.isAbsolute(init.output)
      ? path.basename(init.output)
      : init.output;
  const config: AgentConfigPayload = {
    agent: init.agent,
    model,
    inputFile: init.input,
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
  } else if (result.category === 'workflow') {
    const finalOutput = result.outputs.at(-1);
    writeTextStdout(
      copiedOutput ??
        finalOutput?.relativePath ??
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

// ---------------------------------------------------------------------------
// chat (interactive tool-use agent)
// ---------------------------------------------------------------------------

const chatCommand = defineCommand({
  meta: { name: 'chat', description: 'Interactive tool-use chat session' },
  args: {
    print: { type: 'boolean', alias: 'p' },
    cwd: { type: 'string' },
    'output-format': {
      type: 'enum',
      options: ['text', 'json', 'ndjson'],
      default: 'text',
    },
    'approval-policy': {
      type: 'enum',
      options: ['never', 'ask', 'yolo'],
      default: 'never',
    },
    agent: { type: 'string', description: 'Tool-use agent for the session' },
    model: { type: 'string', alias: 'm', description: 'Model for the session' },
    'tool-display': {
      type: 'enum',
      options: ['grouped', 'minimal', 'hidden'],
      default: 'minimal',
      description: 'Tool/progress rows: grouped, minimal, or hidden',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const { runChat } = await import('../chat/runChat');
    const result = await runChat(context, {
      agentOverride:
        typeof ctx.args.agent === 'string' ? ctx.args.agent : undefined,
      modelOverride:
        typeof ctx.args.model === 'string' ? ctx.args.model : undefined,
      toolDisplay: ctx.args['tool-display'],
    });
    setExitCode(result.exitCode);
  },
});

// ---------------------------------------------------------------------------
// help (synthetic subcommand used as the no-TTY default)
// ---------------------------------------------------------------------------

const helpCommand = defineCommand({
  meta: { name: 'help', description: 'Show TeXRA CLI usage' },
  async run() {
    const { showUsage } = await import('citty');
    await showUsage(rootCommand);
  },
});

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

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
    print: { type: 'boolean', alias: 'p' },
    cwd: { type: 'string' },
    'output-format': {
      type: 'enum',
      options: ['text', 'json', 'ndjson'],
      default: 'text',
    },
    'approval-policy': {
      type: 'enum',
      options: ['never', 'ask', 'yolo'],
      default: 'never',
    },
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

const GLOBAL_VALUE_FLAGS = new Set([
  '--cwd',
  '--output-format',
  '--approval-policy',
]);
const GLOBAL_BOOL_FLAGS = new Set(['--print', '-p']);

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

export async function runCli(
  argv?: readonly string[],
): Promise<{ exitCode: number }> {
  pendingExitCode = CliExitCode.Success;
  const rawArgs = reorderGlobalFlags(argv ? [...argv] : readCliArgv());
  try {
    // Citty's `runMain` handles `--help`/`-h` (showUsage + exit 0) and
    // `--version`/`-v` (printed via meta.version). Subcommand dispatch is
    // delegated to `runCommand`; on a CLIError, runMain prints usage + the
    // error and calls process.exit(1) before this wrapper resumes.
    await runMain(rootCommand, { rawArgs });
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeTextStderr(error.message);
      return { exitCode: CliExitCode.Usage };
    }
    throw error;
  }
  return { exitCode: pendingExitCode };
}

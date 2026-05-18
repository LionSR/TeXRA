import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { defineCommand, runCommand, showUsage, type CommandDef } from 'citty';
import { glob, hasMagic } from 'glob';

import { getAgent, getVisibleAgents, loadAgents } from '@agent/index';
import { writeTerminalStatus } from '@agent/storage';
import { getSafeDocumentRelativePath } from '@agent/utils/outputFileUtils';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { OutputFileSummary } from '@agent/runtime/AgentFlowResult';
import { runValidatedExecutionRequest } from '@agent/runtime/runExecutionRequest';
import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import { isOAuthProvider } from '@auth/sharedConfig';
import { toErrorMessage } from '@common/errors/errorMessage';
import {
  EXECUTION_STATUS,
  type ExecutionId,
  type ExecutionStatus,
} from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';
import { isNonEmptyString } from '@utils/core/stringCore';

import {
  buildCliContext,
  CliUsageError,
  readCliAmbientState,
  readCliArgv,
  readCliVersion,
  type CliContext,
} from '../runtime/cliContext';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  CLI_OUTPUT_FORMATS,
  resolveConfiguredModel,
  type CliOutputFormat,
} from '../runtime/cliConfig';
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
import {
  fetchRelayUsageSummary,
  type RelayUsageSummary,
} from '../runtime/relayUsage';
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
import { shouldRenderRunProgress } from '../runtime/runProgressRenderer';
import {
  buildDoctorReport,
  doctorExitCode,
  writeDoctorReport,
} from '../runtime/doctor';
import {
  generateCompletionScript,
  parseCompletionShell,
} from '../runtime/completion';
import {
  cliHistoryNdjsonRecords,
  deleteCliHistory,
  formatCliHistoryDetailsText,
  formatCliHistoryText,
  listCliHistoryEntries,
  parseCliHistoryId,
  readCliHistoryConfig,
  readCliHistoryDetails,
} from '../runtime/history';

// One CLI invocation per process — module-level pending exit code is the
// simplest way to surface handler exit codes back to `bin/texra.ts` after
// `runCommand` returns. citty's `ctx.data` would also work but is `any`-typed.
let pendingExitCode: number = CliExitCode.Success;

function setExitCode(code: number): void {
  pendingExitCode = code;
}

async function contextFromArgs(args: ParsedGlobalArgs): Promise<CliContext> {
  const context = await buildCliContext({ globalArgs: pickGlobalArgs(args) });
  if (context.quietLogs !== true) {
    for (const warning of context.configWarnings ?? []) {
      writeTextStderr(`WARN ${warning}`);
    }
  }
  return context;
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function collectStringFlagValues(
  rawArgs: readonly string[],
  longName: string,
  shortName: string,
): string[] {
  const longFlag = `--${longName}`;
  const inlineLongPrefix = `${longFlag}=`;
  const shortFlag = `-${shortName}`;
  const values: string[] = [];

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === undefined || arg === '--') break;

    if (arg.startsWith(inlineLongPrefix)) {
      const value = arg.slice(inlineLongPrefix.length).trim();
      if (value) values.push(value);
      continue;
    }

    if (arg === longFlag || arg === shortFlag) {
      const value = rawArgs[i + 1];
      if (value === undefined) {
        throw new CliUsageError(`Missing value for ${arg}`);
      }
      values.push(value);
      i += 1;
    }
  }

  return values;
}

/**
 * Single source of truth for the global flags accepted by every TeXRA
 * subcommand. `as const` + spread would lose literal-type narrowing (citty's
 * `ArgsDef` rejects `readonly string[]`), so each enum's `options` is
 * explicitly typed as a mutable literal tuple — assignable to `string[]` and
 * narrow enough for `defineCommand<const T>` to expose the per-option literal
 * on `ctx.args[...]`. Adding a new global flag is a one-line change here.
 */
const GLOBAL_ARGS: {
  print: { type: 'boolean'; alias: 'p' };
  quiet: { type: 'boolean'; alias: 'q' };
  cwd: { type: 'string' };
  'api-mode': { type: 'string' };
  'output-format': {
    type: 'enum';
    options: CliOutputFormat[];
  };
  'approval-policy': {
    type: 'enum';
    options: CliApprovalPolicy[];
  };
} = {
  print: { type: 'boolean', alias: 'p' },
  quiet: { type: 'boolean', alias: 'q' },
  cwd: { type: 'string' },
  'api-mode': { type: 'string' },
  'output-format': {
    type: 'enum',
    options: [...CLI_OUTPUT_FORMATS],
  },
  'approval-policy': {
    type: 'enum',
    options: [...CLI_APPROVAL_POLICIES],
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
  if (init.provider === 'github' && init.selectAccount && !init.loginHint) {
    writeTextStderr(
      'GitHub does not support --select-account by itself. Use --login-hint <username> to request a specific GitHub account.',
    );
  }
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

const usageCommand = defineCommand({
  meta: { name: 'usage', description: 'Show relay usage for this account' },
  args: {
    ...GLOBAL_ARGS,
    month: {
      type: 'string',
      description: 'UTC month to show, formatted as YYYY-MM',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    let summary: RelayUsageSummary;
    try {
      await initCliPlatform({ ...context, quietLogs: true });
      const profile = await getCliAuthProfile();
      if (!profile.authenticated) {
        writeTextStderr('Not signed in. Run `texra login` first.');
        setExitCode(CliExitCode.ModelOrNetworkError);
        return;
      }
      summary = await fetchRelayUsageSummary({
        tier: profile.tier ?? 'free',
        month: optString(ctx.args.month),
      });
    } catch (error) {
      writeTextStderr(toErrorMessage(error));
      setExitCode(CliExitCode.ModelOrNetworkError);
      return;
    }

    writeRelayUsageSummary(context, summary);
    setExitCode(CliExitCode.Success);
  },
});

function writeRelayUsageSummary(
  context: CliContext,
  summary: RelayUsageSummary,
): void {
  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(summary, null, 2));
    return;
  }

  if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'relay-usage',
      ts: new Date().toISOString(),
      ...summary,
    });
    return;
  }

  const month = summary.periodStart.slice(0, 7);
  writeTextStdout(
    [
      `Relay usage for ${month} (${summary.tier})`,
      `Spend: $${summary.costUsd.toFixed(2)} / $${summary.limitUsd.toFixed(2)} (${summary.usagePercent.toFixed(1)}%)`,
      `Remaining: $${summary.remainingUsd.toFixed(2)}`,
      `Streams: ${summary.streamCount}`,
      `Tokens: ${summary.inputTokens} input (${summary.cachedTokens} cached), ${summary.outputTokens} output, ${summary.reasoningTokens} reasoning`,
      `Models: ${summary.modelsUsed}; providers: ${summary.providersUsed}`,
    ].join('\n'),
  );
}

const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: 'Check CLI runtime dependencies' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await runDoctor(context));
  },
});

async function runDoctor(context: CliContext): Promise<number> {
  let initError: unknown;
  try {
    await initCliPlatform({
      ...context,
      quietLogs: true,
      skipIncludedModelAccess: true,
    });
  } catch (error) {
    initError = error;
  }
  const report = await buildDoctorReport(
    context,
    initError == null
      ? undefined
      : {
          authProfile: async () => {
            throw initError;
          },
          modelAccessList: async () => {
            throw initError;
          },
        },
  );
  writeDoctorReport(context, report);
  return doctorExitCode(report);
}

const authCommand = defineCommand({
  meta: { name: 'auth', description: 'Authentication commands' },
  subCommands: { status: authStatusCommand, usage: usageCommand },
});

const historyListCommand = defineCommand({
  meta: { name: 'list', description: 'List stored executions' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await runHistoryList(context));
  },
});

async function runHistoryList(context: CliContext): Promise<number> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });
  const entries = await listCliHistoryEntries();

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(entries, null, 2));
    return CliExitCode.Success;
  }

  if (context.outputFormat === 'ndjson') {
    for (const record of cliHistoryNdjsonRecords(entries)) {
      writeNdjsonStdout(record);
    }
    return CliExitCode.Success;
  }

  writeTextStdout(
    entries.length
      ? formatCliHistoryText(entries)
      : 'No execution history found.',
  );
  return CliExitCode.Success;
}

const historyShowCommand = defineCommand({
  meta: { name: 'show', description: 'Show one stored execution' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Execution id from `texra history list`',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const id = parseCliHistoryId(ctx.args.id);
    if (!id) {
      writeTextStderr(`Invalid execution id: ${ctx.args.id}`);
      setExitCode(CliExitCode.Usage);
      return;
    }
    setExitCode(await runHistoryShow(context, id));
  },
});

async function runHistoryShow(
  context: CliContext,
  id: ExecutionId,
): Promise<number> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });
  const details = await readCliHistoryDetails(id);
  if (!details) {
    writeTextStderr(`Execution not found: ${id}`);
    return CliExitCode.Usage;
  }

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(details, null, 2));
  } else if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'history-detail',
      ts: new Date().toISOString(),
      detail: details,
    });
  } else {
    writeTextStdout(formatCliHistoryDetailsText(details));
  }
  return CliExitCode.Success;
}

const historyDeleteCommand = defineCommand({
  meta: { name: 'delete', description: 'Delete stored executions' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: false,
      description: 'Execution id from `texra history list`',
    },
    all: {
      type: 'boolean',
      description: 'Delete all stored executions',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const rawId = optString(ctx.args.id);
    const id = rawId ? parseCliHistoryId(rawId) : undefined;
    if (rawId && !id) {
      writeTextStderr(`Invalid execution id: ${rawId}`);
      setExitCode(CliExitCode.Usage);
      return;
    }
    setExitCode(
      await runHistoryDelete(context, { id, all: ctx.args.all === true }),
    );
  },
});

async function runHistoryDelete(
  context: CliContext,
  options: { id?: ExecutionId; all: boolean },
): Promise<number> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });
  let result: Awaited<ReturnType<typeof deleteCliHistory>>;
  try {
    result = await deleteCliHistory(options);
  } catch (error) {
    writeTextStderr(toErrorMessage(error));
    return CliExitCode.Usage;
  }

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(result, null, 2));
  } else if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'history-delete',
      ts: new Date().toISOString(),
      result,
    });
  } else if (result.deleted === 'all') {
    writeTextStdout('Deleted all stored executions.');
  } else if (result.found) {
    writeTextStdout(`Deleted execution ${result.id}.`);
  } else {
    writeTextStderr(`Execution not found: ${result.id}`);
    return CliExitCode.Usage;
  }
  return CliExitCode.Success;
}

const historyCommand = defineCommand({
  meta: { name: 'history', description: 'Inspect stored executions' },
  subCommands: {
    list: historyListCommand,
    show: historyShowCommand,
    delete: historyDeleteCommand,
  },
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
    context: {
      type: 'string',
      alias: 'c',
      description: 'Read-only context file passed to the workflow agent',
    },
    output: { type: 'string', description: 'Output file path' },
    'output-dir': {
      type: 'string',
      description: 'Directory to copy multi-input workflow outputs into',
    },
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
        inputFiles: collectStringFlagValues(ctx.rawArgs, 'input', 'i'),
        contextFiles: collectStringFlagValues(ctx.rawArgs, 'context', 'c'),
        output: optString(ctx.args.output),
        outputDir: optString(ctx.args['output-dir']),
        model: optString(ctx.args.model),
        instruction: optString(ctx.args.instruction) ?? '',
      }),
    );
  },
});

type ExecuteAgentResult = Awaited<
  ReturnType<typeof runValidatedExecutionRequest>
>;
type CliRunResult = ExecuteAgentResult & {
  terminalStatus: ExecutionStatus;
  copiedOutput?: string;
  copiedOutputs?: string[];
};

interface WorkflowRunInit {
  readonly agent: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly output?: string;
  readonly outputDir?: string;
  readonly model?: string;
  readonly instruction: string;
}

function normalizeCliInputPath(candidate: string, cwd: string): string {
  const absolutePath = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(cwd, candidate);
  const relativePath = path.relative(cwd, absolutePath);
  if (
    relativePath &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  ) {
    return relativePath.replaceAll(path.sep, '/');
  }
  return absolutePath;
}

async function expandWorkflowInputSpec(
  inputSpec: string,
  cwd: string,
): Promise<string[]> {
  const trimmed = inputSpec.trim();
  if (!trimmed) return [];

  if (hasMagic(trimmed)) {
    const matches = path.isAbsolute(trimmed)
      ? await glob(trimmed.replaceAll('\\', '/'), {
          absolute: true,
          nodir: true,
        })
      : await glob(trimmed.replaceAll('\\', '/'), {
          cwd,
          absolute: false,
          nodir: true,
        });
    if (matches.length === 0) {
      throw new CliUsageError(`No input files matched: ${trimmed}`);
    }
    return matches.sort().map((match) => normalizeCliInputPath(match, cwd));
  }

  const absolutePath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(cwd, trimmed);
  const stats = await fs.stat(absolutePath).catch(() => null);
  if (stats?.isDirectory()) {
    const matches = await glob('**/*.tex', {
      cwd: absolutePath,
      absolute: true,
      nodir: true,
    });
    if (matches.length === 0) {
      throw new CliUsageError(
        `No .tex input files found in directory: ${trimmed}`,
      );
    }
    return matches.sort().map((match) => normalizeCliInputPath(match, cwd));
  }

  return [normalizeCliInputPath(trimmed, cwd)];
}

export async function expandWorkflowInputSpecs(
  inputSpecs: readonly string[],
  cwd: string,
): Promise<string[]> {
  const expanded = (
    await Promise.all(
      inputSpecs.map((spec) => expandWorkflowInputSpec(spec, cwd)),
    )
  ).flat();
  const unique = [...new Set(expanded)];
  if (unique.length === 0) {
    throw new CliUsageError('At least one workflow input file is required.');
  }
  return unique;
}

function outputCopyRelativePath(output: OutputFileSummary) {
  const relativePath =
    output.relativePath || path.basename(output.absolutePath);
  const parts = relativePath.replaceAll('\\', '/').split('/');
  const withoutRoundDir = /^r\d+$/.test(parts[0] ?? '')
    ? parts.slice(1)
    : parts;
  return getSafeDocumentRelativePath(withoutRoundDir.join('/'));
}

async function resolveWorkflowOutput(
  outputFile: string | undefined,
  outputDir: string | undefined,
  result: ExecuteAgentResult,
  context: CliContext,
): Promise<{
  copiedOutput: string | undefined;
  displayResult: CliRunResult;
}> {
  const baseResult: CliRunResult = {
    ...result,
    terminalStatus: cliTerminalStatus(result),
  };
  if (outputDir && result.category === AgentCategory.Workflow) {
    const targetRoot = path.isAbsolute(outputDir)
      ? outputDir
      : path.join(context.cwd, outputDir);
    const copiedOutputs: string[] = [];
    for (const output of result.outputs) {
      const targetPath = path.join(targetRoot, outputCopyRelativePath(output));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(output.absolutePath, targetPath);
      copiedOutputs.push(targetPath);
    }

    const displayResult: CliRunResult = {
      ...baseResult,
      copiedOutputs,
    };
    return { copiedOutput: undefined, displayResult };
  }

  if (!outputFile || result.category !== AgentCategory.Workflow) {
    return { copiedOutput: undefined, displayResult: baseResult };
  }

  const finalOutput = result.outputs.at(-1);
  if (!finalOutput) {
    return { copiedOutput: undefined, displayResult: baseResult };
  }

  const targetPath = path.isAbsolute(outputFile)
    ? outputFile
    : path.join(context.cwd, outputFile);
  if (path.resolve(finalOutput.absolutePath) !== path.resolve(targetPath)) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(finalOutput.absolutePath, targetPath);
  }

  const displayResult: CliRunResult = {
    ...baseResult,
    copiedOutput: targetPath,
  };
  return { copiedOutput: targetPath, displayResult };
}

function cliTerminalStatus(result: ExecuteAgentResult): ExecutionStatus {
  return result.status === 'error'
    ? EXECUTION_STATUS.ERROR
    : EXECUTION_STATUS.COMPLETED;
}

async function runWorkflowAgent(
  context: CliContext,
  init: WorkflowRunInit,
): Promise<number> {
  const model =
    init.model?.trim() ||
    context.envModel ||
    resolveConfiguredModel(context.cliConfig, 'run') ||
    CLI_BUILTIN_DEFAULT_MODEL;
  const renderRunProgress = shouldRenderRunProgress(context);
  const runContext: CliContext = {
    ...context,
    helperModel: model,
    quietLogs: true,
    renderRunProgress,
  };
  if (init.output && init.outputDir) {
    throw new CliUsageError('Use either --output or --output-dir, not both.');
  }
  const inputFiles = await expandWorkflowInputSpecs(
    init.inputFiles,
    runContext.cwd,
  );
  if (init.output && inputFiles.length > 1) {
    throw new CliUsageError(
      'Use --output-dir for multi-input workflow runs; --output is only for a single final artifact.',
    );
  }

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
    inputFiles,
    contextFiles: init.contextFiles,
    outputFiles: modelOutputFile ? [modelOutputFile] : [],
    instruction: init.instruction,
    workingDirectory: runContext.cwd,
    agentCategory: AgentCategory.Workflow,
  };

  const executionId = generateExecutionId();
  const registeredConfig = AgentConfigSchema.parse(config);
  const runtimeHost = createCliRuntimeHost(runContext);
  let result: ExecuteAgentResult;
  try {
    result = await runValidatedExecutionRequest(
      { config: registeredConfig, executionId },
      {
        runtimeHost,
        enforceCategory: true,
        registerExecution: true,
      },
    );
  } catch (error) {
    await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
    throw error;
  } finally {
    await runtimeHost.close();
  }

  const { copiedOutput, displayResult } = await resolveWorkflowOutput(
    init.output,
    init.outputDir,
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

const resumeCommand = defineCommand({
  meta: { name: 'resume', description: 'Re-run a stored execution config' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Execution id from `texra history list`',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const id = parseCliHistoryId(ctx.args.id);
    if (!id) {
      writeTextStderr(`Invalid execution id: ${ctx.args.id}`);
      setExitCode(CliExitCode.Usage);
      return;
    }
    setExitCode(await runResumeExecution(context, id));
  },
});

async function runResumeExecution(
  context: CliContext,
  id: ExecutionId,
): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const config = await readCliHistoryConfig(id);
  if (!config) {
    writeTextStderr(`Execution not found: ${id}`);
    return CliExitCode.Usage;
  }

  const runContext: CliContext = {
    ...context,
    helperModel: config.model,
    quietLogs: true,
    renderRunProgress: shouldRenderRunProgress(context),
  };
  await initCliPlatform(runContext);
  installCliApprovalHandlers(runContext);
  await loadAgents({ includeRemote: false });
  if (
    !getAgent(config.agent) ||
    (await shouldHonorRemoteAgentPriority(config.agent))
  ) {
    await loadAgents();
  }

  const runtimeHost = createCliRuntimeHost(runContext);
  let result: ExecuteAgentResult;
  try {
    result = await runValidatedExecutionRequest(
      { config, executionId: id },
      { runtimeHost },
    );
  } finally {
    await runtimeHost.close();
  }

  if (runContext.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(result, null, 2));
  } else if (runContext.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'result',
      ts: new Date().toISOString(),
      result,
    });
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
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const { runChat } = await import('../chat/tui/runChatTui');
    const result = await runChat(context, {
      agentOverride: optString(ctx.args.agent),
      modelOverride: optString(ctx.args.model),
    });
    setExitCode(result.exitCode);
  },
});

const helpCommand = defineCommand({
  meta: { name: 'help', description: 'Show TeXRA CLI commands' },
  async run() {
    await showUsage(rootCommand);
  },
});

const completionCommand = defineCommand({
  meta: { name: 'completion', description: 'Print shell completion script' },
  args: {
    ...GLOBAL_ARGS,
    shell: {
      type: 'positional',
      required: true,
      description: 'Shell name: bash, zsh, or fish',
    },
  },
  async run(ctx) {
    try {
      writeTextStdout(
        await generateCompletionScript(
          rootCommand,
          parseCompletionShell(ctx.args.shell),
        ),
      );
    } catch (error) {
      throw new CliUsageError(toErrorMessage(error));
    }
    setExitCode(CliExitCode.Success);
  },
});

export const rootCommand = defineCommand({
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
    resume: resumeCommand,
    history: historyCommand,
    agents: agentsCommand,
    models: modelsCommand,
    login: loginCommand,
    logout: logoutCommand,
    usage: usageCommand,
    auth: authCommand,
    doctor: doctorCommand,
    completion: completionCommand,
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

interface LeadingGlobalFlags {
  readonly leadingGlobals: readonly string[];
  readonly restIndex: number;
  readonly stoppedOnUnknownFlag: boolean;
}

function collectLeadingGlobalFlags(
  rawArgs: readonly string[],
): LeadingGlobalFlags {
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
    return { leadingGlobals, restIndex: i, stoppedOnUnknownFlag: true };
  }
  return { leadingGlobals, restIndex: i, stoppedOnUnknownFlag: false };
}

/**
 * Citty's runCommand consumes args at the root and passes only `rawArgs.slice(
 * subCommandIndex + 1)` to the matched subcommand. That means global flags
 * appearing before the subcommand name (`texra --output-format ndjson agents
 * list`) never reach the subcommand's parser. We sidestep that by lifting
 * leading global flags to the end of rawArgs so they live inside the
 * subcommand's slice. No-op when there is no subcommand or no leading globals.
 */
export function reorderGlobalFlags(rawArgs: readonly string[]): string[] {
  const { leadingGlobals, restIndex, stoppedOnUnknownFlag } =
    collectLeadingGlobalFlags(rawArgs);
  if (stoppedOnUnknownFlag) {
    // Unknown leading flag: leave the rest intact so runMain can surface
    // `--help`, `--version`, or an unknown-flag error.
    return [...rawArgs];
  }
  if (restIndex >= rawArgs.length || leadingGlobals.length === 0) {
    return [...rawArgs];
  }
  return [...rawArgs.slice(restIndex), ...leadingGlobals];
}

export function normalizeRootShortcuts(rawArgs: readonly string[]): string[] {
  const { leadingGlobals, restIndex } = collectLeadingGlobalFlags(rawArgs);
  if (rawArgs[restIndex] !== '--logout') return [...rawArgs];
  return ['logout', ...leadingGlobals, ...rawArgs.slice(restIndex + 1)];
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
    (rawArgs[0] === '--version' || rawArgs[0] === '-v' || rawArgs[0] === '-V')
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

// Standard library imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Local imports - agent and model surfaces
import { getVisibleAgents, loadAgents } from '@agent/index';
import {
  DEFAULT_AGENT_MODEL,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import { isOAuthProvider } from '@auth/sharedConfig';
import { toErrorMessage } from '@common/errors/errorMessage';

// Local imports - CLI runtime
import {
  applyCliGlobalArgs,
  CliUsageError,
  flagValue,
  resolveCliContext,
  type CliContext,
} from '../runtime/cliContext';
import {
  CLI_BOOLEAN_FLAGS,
  GLOBAL_FLAGS_WITH_VALUE,
  RUN_FLAGS_WITH_VALUE,
  cliFlagName,
} from '../runtime/cliFlags';
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
import {
  loginArgParseErrorMessage,
  parseLoginArgs,
  type ParsedLoginArgs,
} from '../runtime/loginArgs';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';

interface CliResult {
  exitCode: number;
}

function printHelp(): void {
  writeTextStdout(`TeXRA CLI

Usage:
  texra --help
  texra [--cwd <dir>] [--output-format text|json|ndjson] [--approval-policy <policy>] <command>
  texra version
  texra login [github|google] [--provider github|google] [--no-browser]
  texra logout
  texra auth status
  texra agents list
  texra models list
  texra run <workflow-agent> [options]
  texra chat [options]

Run options:
  --instruction <text>    Instruction passed to the workflow agent

Chat options:
  --agent <name>          Tool-use agent for the chat session
  --model, -m <name>      Model for the chat session
  --tool-display <mode>   Tool/progress rows: grouped, minimal, or hidden

Login options:
  --provider <name>       OAuth provider: github or google
  --no-browser            Print the sign-in URL instead of opening a browser

Use texra run for workflow agents and texra chat for an interactive tool-use session.`);
}

function splitRunArgs(args: readonly string[]): {
  agent: string | undefined;
  optionArgs: readonly string[];
  unknownFlag?: string;
} {
  const optionArgs: string[] = [];
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    if (arg == null) break;
    if (!arg.startsWith('-')) {
      return {
        agent: arg,
        optionArgs: [...optionArgs, ...args.slice(index + 1)],
      };
    }

    optionArgs.push(arg);
    const value = args[index + 1];
    const flagName = cliFlagName(arg);
    const flagTakesValue =
      RUN_FLAGS_WITH_VALUE.has(flagName) ||
      GLOBAL_FLAGS_WITH_VALUE.has(flagName);
    if (!flagTakesValue) {
      if (CLI_BOOLEAN_FLAGS.has(flagName)) {
        index += 1;
        continue;
      }
      return { agent: undefined, optionArgs, unknownFlag: arg };
    }
    if (arg.includes('=')) {
      index += 1;
      continue;
    }
    if (value != null) {
      optionArgs.push(value);
      index += 2;
      continue;
    }
    index += 1;
  }

  return {
    agent: undefined,
    optionArgs,
  };
}

async function listAgents(context: CliContext): Promise<CliResult> {
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
    return { exitCode: 0 };
  }

  if (context.outputFormat === 'ndjson') {
    const ts = new Date().toISOString();
    for (const agent of agents) {
      writeNdjsonStdout({ kind: 'agent', ts, agent });
    }
    return { exitCode: 0 };
  }

  for (const agent of agents) {
    writeTextStdout(
      `${agent.category}\t${agent.name}\t${agent.description ?? ''}`,
    );
  }
  return { exitCode: 0 };
}

async function listModels(context: CliContext): Promise<CliResult> {
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
    return { exitCode: 0 };
  }

  if (context.outputFormat === 'ndjson') {
    const ts = new Date().toISOString();
    for (const { model } of modelAccess) {
      writeNdjsonStdout({ kind: 'model', ts, model });
    }
    return { exitCode: 0 };
  }

  for (const { model, status } of modelAccess) {
    writeTextStdout(`${model.value}\t${model.label}\t${status}`);
  }
  return { exitCode: 0 };
}

async function login(context: CliContext): Promise<CliResult> {
  const args = context.argv.slice(1);
  const { globalArgs, provider, noBrowser } = parseRootLoginArgs(args);
  const loginContext = applyCliGlobalArgs(context, globalArgs);
  if (!isOAuthProvider(provider)) {
    writeTextStderr(
      `Unsupported provider: ${provider}. Expected github or google.`,
    );
    return { exitCode: CliExitCode.Usage };
  }

  await initCliPlatform({ ...loginContext, quietLogs: true });
  if (loginContext.outputFormat === 'text' && !noBrowser) {
    writeTextStdout(`Opening browser for TeXRA ${provider} sign-in...`);
  }
  let session: Awaited<ReturnType<typeof signInCliSupabase>>;
  try {
    session = await signInCliSupabase({
      provider,
      openBrowser: !noBrowser,
      onAuthUrl: (url) => {
        if (noBrowser) {
          const writeAuthUrl =
            loginContext.outputFormat === 'text'
              ? writeTextStdout
              : writeTextStderr;
          writeAuthUrl(`Open this URL to sign in:\n${url}`);
        }
      },
    });
  } catch (error) {
    writeTextStderr(toErrorMessage(error));
    return { exitCode: CliExitCode.ModelOrNetworkError };
  }

  if (loginContext.outputFormat === 'json') {
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
  } else if (loginContext.outputFormat === 'ndjson') {
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
  return { exitCode: CliExitCode.Success };
}

function parseRootLoginArgs(args: readonly string[]): ParsedLoginArgs {
  const parsed = parseLoginArgs(args, { allowGlobalArgs: true });
  if (parsed.error) {
    throw new CliUsageError(loginArgParseErrorMessage(parsed.error));
  }
  return parsed;
}

function parseAuthGlobalArgs(
  args: readonly string[],
  commandName: string,
): readonly string[] {
  const parsed = parseLoginArgs(args, {
    allowGlobalArgs: true,
    allowLoginOptions: false,
  });
  if (parsed.error) {
    throw new CliUsageError(
      loginArgParseErrorMessage(parsed.error, commandName),
    );
  }
  return parsed.globalArgs;
}

async function logout(context: CliContext): Promise<CliResult> {
  const logoutContext = applyCliGlobalArgs(
    context,
    parseAuthGlobalArgs(context.argv.slice(1), 'logout'),
  );
  await initCliPlatform({ ...logoutContext, quietLogs: true });
  try {
    await signOutCliSupabase();
  } catch (error) {
    writeTextStderr(toErrorMessage(error));
    return { exitCode: CliExitCode.ModelOrNetworkError };
  }

  if (logoutContext.outputFormat === 'json') {
    writeTextStdout(JSON.stringify({ authenticated: false }, null, 2));
  } else if (logoutContext.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'auth',
      ts: new Date().toISOString(),
      authenticated: false,
    });
  } else {
    writeTextStdout('Signed out.');
  }
  return { exitCode: CliExitCode.Success };
}

async function authStatus(context: CliContext): Promise<CliResult> {
  const statusContext = applyCliGlobalArgs(
    context,
    parseAuthGlobalArgs(context.argv.slice(2), 'auth status'),
  );
  let profile: Awaited<ReturnType<typeof getCliAuthProfile>>;
  try {
    await initCliPlatform({ ...statusContext, quietLogs: true });
    profile = await getCliAuthProfile();
  } catch (error) {
    writeTextStderr(toErrorMessage(error));
    return { exitCode: CliExitCode.ModelOrNetworkError };
  }

  if (statusContext.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(profile, null, 2));
  } else if (statusContext.outputFormat === 'ndjson') {
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
  return { exitCode: CliExitCode.Success };
}

type ExecuteAgentResult = Awaited<ReturnType<typeof executeAgent>>;

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
  agent: string | undefined,
  args: readonly string[],
  context: CliContext,
): Promise<CliResult> {
  if (!agent || agent.startsWith('-')) {
    writeTextStderr(
      'Usage: texra run <workflow-agent> --input <file> [--output <file>] [--model <model>]',
    );
    return { exitCode: CliExitCode.Usage };
  }

  const inputFile = flagValue(args, '--input', '-i');
  if (!inputFile) {
    writeTextStderr('Missing required flag: --input <file>');
    return { exitCode: CliExitCode.Usage };
  }

  const model = flagValue(args, '--model', '-m')?.trim() || DEFAULT_AGENT_MODEL;
  const runContext = {
    ...applyCliGlobalArgs(context, args),
    helperModel: model,
    quietLogs: true,
  };
  await initCliPlatform(runContext);
  installCliApprovalHandlers(runContext);
  await loadAgents();

  const outputFile = flagValue(args, '--output');
  const modelOutputFile =
    outputFile && path.isAbsolute(outputFile)
      ? path.basename(outputFile)
      : outputFile;
  const config: AgentConfigPayload = {
    agent,
    model,
    inputFile,
    outputFiles: modelOutputFile ? [modelOutputFile] : [],
    instruction: flagValue(args, '--instruction') ?? '',
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
    outputFile,
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

  if (result.status !== 'error') return { exitCode: CliExitCode.Success };
  return {
    exitCode: hasCliApprovalDenied(runContext)
      ? CliExitCode.ApprovalDenied
      : CliExitCode.AgentError,
  };
}

async function runCliResolved(argv?: readonly string[]): Promise<CliResult> {
  const context = await resolveCliContext(argv);
  const [command, subcommand] = context.argv;

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return { exitCode: CliExitCode.Success };
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    writeTextStdout(context.version);
    return { exitCode: CliExitCode.Success };
  }

  if (command === 'login') {
    return login(context);
  }

  if (command === 'logout') {
    return logout(context);
  }

  if (command === 'auth' && subcommand === 'status') {
    return authStatus(context);
  }

  if (command === 'agents' && subcommand === 'list') {
    return listAgents(context);
  }

  if (command === 'models' && subcommand === 'list') {
    return listModels(context);
  }

  if (command === 'run') {
    const { agent, optionArgs, unknownFlag } = splitRunArgs(
      context.argv.slice(1),
    );
    if (unknownFlag) {
      writeTextStderr(`Unknown run flag: ${unknownFlag}`);
      return { exitCode: CliExitCode.Usage };
    }
    return runWorkflowAgent(agent, optionArgs, context);
  }

  if (command === 'chat') {
    const { runChat } = await import('../chat/runChat');
    return runChat(context);
  }

  writeTextStderr(`Unknown command: ${command}`);
  printHelp();
  return { exitCode: CliExitCode.Usage };
}

export async function runCli(argv?: readonly string[]): Promise<CliResult> {
  try {
    return await runCliResolved(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeTextStderr(error.message);
      return { exitCode: CliExitCode.Usage };
    }
    throw error;
  }
}

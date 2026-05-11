// Local imports - agent and model surfaces
import {
  DEFAULT_AGENT_MODEL,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { getVisibleAgents, loadAgents } from '@agent/index';
import { executeAgent } from '@agent/runtime/executeAgent';
import { computeModelOptionsData } from '@model/computeModelOptions';

// Local imports - CLI runtime
import {
  applyCliGlobalArgs,
  cliFlagName,
  CLI_BOOLEAN_FLAGS,
  CliUsageError,
  flagValue,
  GLOBAL_FLAGS_WITH_VALUE,
  resolveCliContext,
  RUN_FLAGS_WITH_VALUE,
  type CliContext,
} from '../runtime/cliContext';
import { installCliApprovalHandlers } from '../runtime/approvalAdapter';
import { initCliPlatform } from '../runtime/initPlatform';
import { createCliRuntimeHost } from '../runtime/runtimeHost';
import { CliExitCode } from '../runtime/exitCodes';
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
  texra agents list
  texra models list
  texra run <workflow-agent> [options]
  texra chat [options]

The chat command is scaffolded here and will be wired to executeAgent in the CLI implementation issues.`);
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
  await initCliPlatform(context);
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
  await initCliPlatform(context);
  const models = await computeModelOptionsData();

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(models, null, 2));
    return { exitCode: 0 };
  }

  if (context.outputFormat === 'ndjson') {
    const ts = new Date().toISOString();
    for (const model of models) {
      writeNdjsonStdout({ kind: 'model', ts, model });
    }
    return { exitCode: 0 };
  }

  for (const model of models) {
    writeTextStdout(`${model.value}\t${model.label}`);
  }
  return { exitCode: 0 };
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

  const runContext = applyCliGlobalArgs(context, args);
  await initCliPlatform(runContext);
  installCliApprovalHandlers(runContext);
  await loadAgents();

  const outputFile = flagValue(args, '--output');
  const model = flagValue(args, '--model', '-m');
  const config: AgentConfigPayload = {
    agent,
    model: model && model.trim().length > 0 ? model : DEFAULT_AGENT_MODEL,
    inputFile,
    outputFiles: outputFile ? [outputFile] : [],
    instruction: flagValue(args, '--instruction') ?? '',
    workingDirectory: runContext.cwd,
  };

  const runtimeHost = createCliRuntimeHost(runContext);
  let result: Awaited<ReturnType<typeof executeAgent>>;
  try {
    result = await executeAgent(config, undefined, { runtimeHost });
  } finally {
    await runtimeHost.close();
  }

  if (runContext.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(result, null, 2));
  } else if (runContext.outputFormat === 'ndjson') {
    writeNdjsonStdout({ kind: 'result', ts: new Date().toISOString(), result });
  } else if (result.category === 'workflow') {
    const finalOutput = result.outputs.at(-1);
    writeTextStdout(
      finalOutput?.relativePath ?? finalOutput?.absolutePath ?? result.status,
    );
  } else {
    writeTextStdout(result.status);
  }

  return {
    exitCode:
      result.status === 'error' ? CliExitCode.AgentError : CliExitCode.Success,
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

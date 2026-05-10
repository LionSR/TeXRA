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
  flagValue,
  resolveCliContext,
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
    if (value != null && !value.startsWith('-')) {
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
  installCliApprovalHandlers(context);
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

  await initCliPlatform(context);
  installCliApprovalHandlers(context);
  await loadAgents();

  const outputFile = flagValue(args, '--output');
  const config: AgentConfigPayload = {
    agent,
    model: flagValue(args, '--model', '-m') ?? DEFAULT_AGENT_MODEL,
    inputFile,
    outputFiles: outputFile ? [outputFile] : [],
    instruction: flagValue(args, '--instruction') ?? '',
    workingDirectory: context.cwd,
  };

  const result = await executeAgent(config, undefined, {
    runtimeHost: createCliRuntimeHost(context),
  });

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(result, null, 2));
  } else if (context.outputFormat === 'ndjson') {
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

export async function runCli(argv?: readonly string[]): Promise<CliResult> {
  const context = await resolveCliContext(argv);
  const [command, subcommand, ...rest] = context.argv;

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
    const { agent, optionArgs } = splitRunArgs(context.argv.slice(1));
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

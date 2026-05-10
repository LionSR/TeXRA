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

interface CliResult {
  exitCode: number;
}

function printHelp(): void {
  console.log(`TeXRA CLI

Usage:
  texra --help
  texra version
  texra agents list [-o json]
  texra models list [-o json]
  texra run <workflow-agent> [options]
  texra chat [options]

The chat command is scaffolded here and will be wired to executeAgent in the CLI implementation issues.`);
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
    console.log(JSON.stringify(agents, null, 2));
    return { exitCode: 0 };
  }

  for (const agent of agents) {
    console.log(`${agent.category}\t${agent.name}\t${agent.description ?? ''}`);
  }
  return { exitCode: 0 };
}

async function listModels(context: CliContext): Promise<CliResult> {
  await initCliPlatform(context);
  const models = await computeModelOptionsData();

  if (context.outputFormat === 'json') {
    console.log(JSON.stringify(models, null, 2));
    return { exitCode: 0 };
  }

  for (const model of models) {
    console.log(`${model.value}\t${model.label}`);
  }
  return { exitCode: 0 };
}

async function runWorkflowAgent(
  agent: string | undefined,
  args: readonly string[],
  context: CliContext,
): Promise<CliResult> {
  if (!agent || agent.startsWith('-')) {
    console.error(
      'Usage: texra run <workflow-agent> --input <file> [--output <file>] [--model <model>]',
    );
    return { exitCode: CliExitCode.Usage };
  }

  const inputFile = flagValue(args, '--input', '-i');
  if (!inputFile) {
    console.error('Missing required flag: --input <file>');
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
    console.log(JSON.stringify(result, null, 2));
  } else if (context.outputFormat === 'ndjson') {
    console.log(
      JSON.stringify({ kind: 'result', ts: new Date().toISOString(), result }),
    );
  } else if (result.category === 'workflow') {
    const finalOutput = result.outputs.at(-1);
    console.log(
      finalOutput?.relativePath ?? finalOutput?.absolutePath ?? result.status,
    );
  } else {
    console.log(result.status);
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
    console.log(context.version);
    return { exitCode: CliExitCode.Success };
  }

  if (command === 'agents' && subcommand === 'list') {
    return listAgents(context);
  }

  if (command === 'models' && subcommand === 'list') {
    return listModels(context);
  }

  if (command === 'run') {
    return runWorkflowAgent(subcommand, rest, context);
  }

  if (command === 'chat') {
    const { runChat } = await import('../chat/runChat');
    return runChat(context);
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  return { exitCode: CliExitCode.Usage };
}

import { defineCommand } from 'citty';
import { execa } from 'execa';
import { parse as shellParse } from 'shell-quote';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import {
  formatCliToolList,
  formatCliToolMissingInstallCommandMessage,
  formatCliToolNotFoundMessage,
  formatCliToolNotToggleableMessage,
  formatCliToolStatus,
  readCliToolGuide,
  readCliToolStatus,
  readCliToolStatuses,
  setCliToolEnabled,
  type CliToolGuide,
} from '../runtime/tools';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

type ToolGuideOperation = 'install' | 'auth';

const TOOL_ID_ARGS = {
  ...GLOBAL_ARGS,
  id: {
    type: 'positional',
    required: true,
    description: 'Tool integration id from `texra tools list`',
  },
} as const;

interface CliToolToggleResult {
  readonly id: string;
  readonly enabled: boolean;
  readonly action: 'enabled' | 'disabled';
}

interface CliToolGuideResult {
  readonly id: string;
  readonly operation: ToolGuideOperation;
  readonly text: string;
  readonly command?: string;
}

async function listTools(context: CliContext): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const records = await readCliToolStatuses();

  emitCliResult(context, {
    json: records,
    ndjson: records.map((tool) => ({ kind: 'tool-status', tool })),
    text: formatCliToolList(records),
  });
  return CliExitCode.Success;
}

async function showTool(context: CliContext, id: string): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const record = await readCliToolStatus(id);
  if (!record) {
    writeTextStderr(formatCliToolNotFoundMessage(id));
    return CliExitCode.Usage;
  }

  emitCliResult(context, {
    json: record,
    ndjson: { kind: 'tool-status', tool: record },
    text: formatCliToolStatus(record),
  });
  return CliExitCode.Success;
}

async function toggleTool(
  context: CliContext,
  id: string,
  enabled: boolean,
): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const ok = await setCliToolEnabled(id, enabled);
  if (!ok) {
    writeTextStderr(formatCliToolNotToggleableMessage(id));
    return CliExitCode.Usage;
  }
  const result: CliToolToggleResult = {
    id,
    enabled,
    action: enabled ? 'enabled' : 'disabled',
  };
  emitCliResult(context, {
    json: result,
    ndjson: { kind: 'tool-toggle', tool: result },
    text: `${enabled ? 'Enabled' : 'Disabled'} ${id}.`,
  });
  return CliExitCode.Success;
}

// Not routed through executeCommand: install/auth guide commands are
// interactive (they can prompt for input or open a browser), which needs true
// stdio:'inherit' that executeCommand's buffered/streamed output can't
// provide. `command` always comes from the static EXTERNAL_TOOL_DEFS registry,
// never from user or LLM input. POSIX commands run as argv; Windows uses the
// shell so npm/gh `.cmd` shims resolve through PATHEXT.
async function shellRun(command: string): Promise<number> {
  // reject: false — a spawn failure and a non-zero exit both map to an exit
  // code here, never to a throw. The parse gates both branches: on Windows the
  // parts are discarded, but a command carrying shell operators still parses to
  // non-strings and is refused before it reaches the shell.
  let parts: string[];
  try {
    const parsed = shellParse(command);
    if (!parsed.every((arg): arg is string => typeof arg === 'string')) {
      return CliExitCode.AgentError;
    }
    parts = parsed;
  } catch {
    return CliExitCode.AgentError;
  }
  if (process.platform === 'win32') {
    const result = await execa(command, {
      shell: true,
      stdio: 'inherit',
      reject: false,
    });
    return result.exitCode ?? CliExitCode.AgentError;
  }
  const [cmd, ...args] = parts;
  if (!cmd) return CliExitCode.AgentError;
  const result = await execa(cmd, args, { stdio: 'inherit', reject: false });
  return result.exitCode ?? CliExitCode.AgentError;
}

function toolGuideResult(
  id: string,
  operation: ToolGuideOperation,
  guide: CliToolGuide,
): CliToolGuideResult {
  return {
    id,
    operation,
    text: guide.text,
    command: guide.command,
  };
}

async function installTool(
  context: CliContext,
  id: string,
  run: boolean,
): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const guide = readCliToolGuide(id, 'install');
  if (!guide) {
    writeTextStderr(formatCliToolNotFoundMessage(id));
    return CliExitCode.Usage;
  }

  // --run launches an external command in the terminal, so it only makes sense
  // in text mode; surface the more specific "no command" guidance when there is
  // nothing to run.
  if (run && context.outputFormat !== 'text') {
    writeTextStderr(
      guide.command
        ? 'Cannot combine --output-format json|ndjson with tools install --run running an external command; use text output to run it, or omit the run request to inspect the guide.'
        : formatCliToolMissingInstallCommandMessage(id),
    );
    return CliExitCode.Usage;
  }

  const result = toolGuideResult(id, 'install', guide);
  emitCliResult(context, {
    json: result,
    ndjson: { kind: 'tool-guide', guide: result },
    text: result.text,
  });
  if (!run) return CliExitCode.Success;
  if (!guide.command) {
    writeTextStderr(formatCliToolMissingInstallCommandMessage(id));
    return CliExitCode.Usage;
  }
  return shellRun(guide.command);
}

async function authTool(context: CliContext, id: string): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const guide = readCliToolGuide(id, 'auth');
  if (!guide) {
    writeTextStderr(formatCliToolNotFoundMessage(id));
    return CliExitCode.Usage;
  }

  const result = toolGuideResult(id, 'auth', guide);
  emitCliResult(context, {
    json: result,
    ndjson: { kind: 'tool-guide', guide: result },
    text: result.text,
  });
  if (!guide.command || context.outputFormat !== 'text')
    return CliExitCode.Success;
  return shellRun(guide.command);
}

const toolsListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List external tool integrations' },
  args: { ...GLOBAL_ARGS },
  run: listTools,
});

const toolsStatusCommand = defineCliCommand({
  meta: { name: 'status', description: 'Show one tool integration' },
  args: TOOL_ID_ARGS,
  run: (context, ctx) => showTool(context, ctx.args.id),
});

function toggleCommand(name: 'enable' | 'disable', enabled: boolean) {
  return defineCliCommand({
    meta: {
      name,
      description: `${enabled ? 'Enable' : 'Disable'} a tool integration`,
    },
    args: TOOL_ID_ARGS,
    run: (context, ctx) => toggleTool(context, ctx.args.id, enabled),
  });
}

const toolsInstallCommand = defineCliCommand({
  meta: { name: 'install', description: 'Show install help for a tool' },
  args: {
    ...TOOL_ID_ARGS,
    run: {
      type: 'boolean',
      description: 'Run the registered install command after printing it',
    },
  },
  run: (context, ctx) =>
    installTool(context, ctx.args.id, ctx.args.run === true),
  catchExitCode: CliExitCode.AgentError,
});

const toolsAuthCommand = defineCliCommand({
  meta: { name: 'auth', description: 'Run or show auth help for a tool' },
  args: TOOL_ID_ARGS,
  run: (context, ctx) => authTool(context, ctx.args.id),
  catchExitCode: CliExitCode.AgentError,
});

export const toolsCommand = defineCommand({
  meta: { name: 'tools', description: 'Inspect external tool integrations' },
  subCommands: {
    list: toolsListCommand,
    status: toolsStatusCommand,
    enable: toggleCommand('enable', true),
    disable: toggleCommand('disable', false),
    install: toolsInstallCommand,
    auth: toolsAuthCommand,
  },
});

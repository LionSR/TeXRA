import { spawn } from 'node:child_process';

import { defineCommand } from 'citty';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeErrorStderr,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
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
} from '../runtime/tools';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

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
  writeTextStdout(`${enabled ? 'Enabled' : 'Disabled'} ${id}.`);
  return CliExitCode.Success;
}

function shellRun(command: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
    });
    child.on('error', () => resolve(CliExitCode.AgentError));
    child.on('exit', (code) => resolve(code ?? CliExitCode.AgentError));
  });
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

  writeTextStdout(guide.text);
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

  writeTextStdout(guide.text);
  if (!guide.command) return CliExitCode.Success;
  try {
    return await shellRun(guide.command);
  } catch (error) {
    writeErrorStderr(error);
    return CliExitCode.AgentError;
  }
}

const toolsListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List external tool integrations' },
  args: { ...GLOBAL_ARGS },
  run: (context) => listTools(context),
});

// Built per key so the usage banner (citty reads `meta.name`) matches the
// invoked alias: `texra tools status --help` prints `tools status`, not `show`.
function toolsShowCommandNamed(name: 'show' | 'status') {
  return defineCliCommand({
    meta: { name, description: 'Show one tool integration' },
    args: {
      ...GLOBAL_ARGS,
      id: {
        type: 'positional',
        required: true,
        description: 'Tool integration id from `texra tools list`',
      },
    },
    run: (context, ctx) => showTool(context, ctx.args.id),
  });
}

function toggleCommand(name: 'enable' | 'disable', enabled: boolean) {
  return defineCliCommand({
    meta: {
      name,
      description: `${enabled ? 'Enable' : 'Disable'} a tool integration`,
    },
    args: {
      ...GLOBAL_ARGS,
      id: {
        type: 'positional',
        required: true,
        description: 'Tool integration id from `texra tools list`',
      },
    },
    run: (context, ctx) => toggleTool(context, ctx.args.id, enabled),
  });
}

const toolsInstallCommand = defineCliCommand({
  meta: { name: 'install', description: 'Show install help for a tool' },
  args: {
    ...GLOBAL_ARGS,
    run: {
      type: 'boolean',
      description: 'Run the registered install command after printing it',
    },
    id: {
      type: 'positional',
      required: true,
      description: 'Tool integration id from `texra tools list`',
    },
  },
  run: (context, ctx) =>
    installTool(context, ctx.args.id, ctx.args.run === true),
});

const toolsAuthCommand = defineCliCommand({
  meta: { name: 'auth', description: 'Run or show auth help for a tool' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Tool integration id from `texra tools list`',
    },
  },
  run: (context, ctx) => authTool(context, ctx.args.id),
});

export const toolsCommand = defineCommand({
  meta: { name: 'tools', description: 'Inspect external tool integrations' },
  subCommands: {
    list: toolsListCommand,
    // `show` is canonical (matches agents/models/history); `status` stays as a
    // back-compat alias.
    show: toolsShowCommandNamed('show'),
    status: toolsShowCommandNamed('status'),
    enable: toggleCommand('enable', true),
    disable: toggleCommand('disable', false),
    install: toolsInstallCommand,
    auth: toolsAuthCommand,
  },
});

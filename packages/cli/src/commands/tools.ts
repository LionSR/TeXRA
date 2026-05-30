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
  findCliToolDef,
  formatCliToolList,
  formatCliToolStatus,
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
    writeTextStderr(`Tool integration not found: ${id}`);
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
    writeTextStderr(`Tool integration is not toggleable: ${id}`);
    return CliExitCode.Usage;
  }
  writeTextStdout(`${enabled ? 'Enabled' : 'Disabled'} ${id}.`);
  return CliExitCode.Success;
}

function formatGuide(id: string, kind: 'install' | 'auth'): string | undefined {
  const def = findCliToolDef(id);
  if (!def) return undefined;
  if (kind === 'install') {
    const lines = [def.installGuide ?? def.configNotes ?? 'No install guide.'];
    if (def.installCommand) {
      lines.push('');
      lines.push(`Command: ${def.installCommand}`);
    }
    if (def.installUrl) {
      lines.push(`URL: ${def.installUrl}`);
    }
    return lines.join('\n');
  }

  const lines = [def.authNote ?? def.configNotes ?? 'No auth guide.'];
  if (def.authCommand) {
    lines.push('');
    lines.push(`Command: ${def.authCommand}`);
  }
  return lines.join('\n');
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
  const def = findCliToolDef(id);
  if (!def) {
    writeTextStderr(`Tool integration not found: ${id}`);
    return CliExitCode.Usage;
  }

  writeTextStdout(formatGuide(id, 'install') ?? '');
  if (!run) return CliExitCode.Success;
  if (!def.installCommand) {
    writeTextStderr(`No install command is registered for ${id}.`);
    return CliExitCode.Usage;
  }
  return shellRun(def.installCommand);
}

async function authTool(context: CliContext, id: string): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const def = findCliToolDef(id);
  if (!def) {
    writeTextStderr(`Tool integration not found: ${id}`);
    return CliExitCode.Usage;
  }

  writeTextStdout(formatGuide(id, 'auth') ?? '');
  if (!def.authCommand) return CliExitCode.Success;
  try {
    return await shellRun(def.authCommand);
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

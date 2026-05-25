import { spawn } from 'node:child_process';

import { defineCommand } from 'citty';

import { toErrorMessage } from '@common/errors';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeNdjsonStdout,
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

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/cliContext';

async function withCliPlatform<T>(
  context: CliContext,
  work: () => Promise<T>,
): Promise<T> {
  await initCliPlatform({ ...context, quietLogs: true });
  return work();
}

async function listTools(context: CliContext): Promise<number> {
  const records = await withCliPlatform(context, readCliToolStatuses);

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(records, null, 2));
    return CliExitCode.Success;
  }

  if (context.outputFormat === 'ndjson') {
    const ts = new Date().toISOString();
    for (const tool of records) {
      writeNdjsonStdout({ kind: 'tool-status', ts, tool });
    }
    return CliExitCode.Success;
  }

  writeTextStdout(formatCliToolList(records));
  return CliExitCode.Success;
}

async function showTool(context: CliContext, id: string): Promise<number> {
  const record = await withCliPlatform(context, () => readCliToolStatus(id));
  if (!record) {
    writeTextStderr(`Tool integration not found: ${id}`);
    return CliExitCode.Usage;
  }

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(record, null, 2));
    return CliExitCode.Success;
  }

  if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'tool-status',
      ts: new Date().toISOString(),
      tool: record,
    });
    return CliExitCode.Success;
  }

  writeTextStdout(formatCliToolStatus(record));
  return CliExitCode.Success;
}

async function toggleTool(
  context: CliContext,
  id: string,
  enabled: boolean,
): Promise<number> {
  const ok = await withCliPlatform(context, () =>
    setCliToolEnabled(id, enabled),
  );
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
    writeTextStderr(toErrorMessage(error));
    return CliExitCode.AgentError;
  }
}

const toolsListCommand = defineCommand({
  meta: { name: 'list', description: 'List external tool integrations' },
  args: { ...GLOBAL_ARGS },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await listTools(context));
  },
});

const toolsStatusCommand = defineCommand({
  meta: { name: 'status', description: 'Show one tool integration status' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Tool integration id from `texra tools list`',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await showTool(context, ctx.args.id));
  },
});

function toggleCommand(name: 'enable' | 'disable', enabled: boolean) {
  return defineCommand({
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
    async run(ctx) {
      const context = await contextFromArgs(ctx.args);
      setExitCode(await toggleTool(context, ctx.args.id, enabled));
    },
  });
}

const toolsInstallCommand = defineCommand({
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
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await installTool(context, ctx.args.id, ctx.args.run === true));
  },
});

const toolsAuthCommand = defineCommand({
  meta: { name: 'auth', description: 'Run or show auth help for a tool' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Tool integration id from `texra tools list`',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await authTool(context, ctx.args.id));
  },
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

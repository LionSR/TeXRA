import { defineCommand } from 'citty';
import { Effect } from 'effect';
import { execa } from 'execa';
import { parse as shellParse } from 'shell-quote';

import type { ToolProbeInputs } from '@tools/externalToolDefs';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { CliExitCode } from '../runtime/exitCodes';
import { installCliProcessRuntime } from '../runtime/cliProcessRuntime';
import {
  initCliPlatform,
  type CliPlatformServices,
} from '../runtime/initPlatform';
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

/**
 * The workspace this command's init opened, as the probes read it: the
 * configuration slot and the folder the init always publishes.
 */
function toolProbeInputs(services: CliPlatformServices): ToolProbeInputs {
  return {
    workspaceRoot: services.roots.workspace,
    config: services.config,
  };
}

async function listTools(context: CliContext): Promise<number> {
  // The command's one run, on the process runtime this entry installs or
  // joins: the init and the status read it feeds are one program on it, so
  // they hit the same state store without a Promise between them.
  const runtime = await installCliProcessRuntime(context.storageRoot);
  return runtime.runPromise(
    Effect.gen(function* () {
      const services = yield* initCliPlatform({ ...context, quietLogs: true });
      const items = yield* readCliToolStatuses(toolProbeInputs(services));

      emitCliResult(context, {
        json: items,
        ndjson: items.map((tool) => ({ kind: 'tool-status', tool })),
        text: formatCliToolList(items),
      });
      return CliExitCode.Success;
    }),
  );
}

async function showTool(context: CliContext, id: string): Promise<number> {
  const runtime = await installCliProcessRuntime(context.storageRoot);
  return runtime.runPromise(
    Effect.gen(function* () {
      const services = yield* initCliPlatform({ ...context, quietLogs: true });
      const item = yield* readCliToolStatus(toolProbeInputs(services), id);
      if (!item) {
        writeTextStderr(formatCliToolNotFoundMessage(id));
        return CliExitCode.Usage;
      }

      emitCliResult(context, {
        json: item,
        ndjson: { kind: 'tool-status', tool: item },
        text: formatCliToolStatus(item),
      });
      return CliExitCode.Success;
    }),
  );
}

async function toggleTool(
  context: CliContext,
  id: string,
  enabled: boolean,
): Promise<number> {
  const runtime = await installCliProcessRuntime(context.storageRoot);
  return runtime.runPromise(
    Effect.gen(function* () {
      const services = yield* initCliPlatform({ ...context, quietLogs: true });
      const ok = yield* setCliToolEnabled(services.globalState, id, enabled);
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
    }),
  );
}

// Not routed through executeCommand: install/auth guide commands are
// interactive (they can prompt for input or open a browser), which needs true
// stdio:'inherit' that executeCommand's buffered/streamed output can't
// provide. `command` always comes from the static EXTERNAL_TOOL_DEFS registry,
// never from user or LLM input. POSIX commands run as argv; Windows uses the
// shell so npm/gh `.cmd` shims resolve through PATHEXT.
const shellRun = Effect.fn('cli.tools.shellRun')(function* (command: string) {
  // reject: false — a spawn failure and a non-zero exit both map to an exit
  // code here, never to a throw. The parse gates both branches: on Windows the
  // parts are discarded, but a command carrying shell operators still parses to
  // non-strings and is refused before it reaches the shell.
  //
  // A refusal fails the command rather than returning a bare exit code: both
  // callers declare `catchExitCode: CliExitCode.AgentError`, which writes the
  // message to stderr and exits with the same code the silent return used, so
  // the only change is that the user is told why nothing ran.
  const parsed = yield* Effect.try({
    try: () => shellParse(command),
    catch: (cause) =>
      new Error(
        `Cannot run the registered command for this tool (${command}): ${toErrorMessage(cause)}`,
      ),
  });
  if (!parsed.every((arg): arg is string => typeof arg === 'string')) {
    return yield* Effect.fail(
      new Error(
        `Refusing to run the registered command for this tool (${command}): it carries shell operators or redirection.`,
      ),
    );
  }
  if (process.platform === 'win32') {
    const result = yield* Effect.promise(() =>
      execa(command, { shell: true, stdio: 'inherit', reject: false }),
    );
    return result.exitCode ?? CliExitCode.AgentError;
  }
  const [cmd, ...args] = parsed;
  if (!cmd) {
    return yield* Effect.fail(
      new Error(
        `The registered command for this tool is empty (${command}); there is nothing to run.`,
      ),
    );
  }
  const result = yield* Effect.promise(() =>
    execa(cmd, args, { stdio: 'inherit', reject: false }),
  );
  return result.exitCode ?? CliExitCode.AgentError;
});

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
  const runtime = await installCliProcessRuntime(context.storageRoot);
  return runtime.runPromise(
    Effect.gen(function* () {
      yield* initCliPlatform({ ...context, quietLogs: true });
      const guide = readCliToolGuide(id, 'install');
      if (!guide) {
        writeTextStderr(formatCliToolNotFoundMessage(id));
        return CliExitCode.Usage;
      }

      // --run launches an external command in the terminal, so it only makes
      // sense in text mode; surface the more specific "no command" guidance
      // when there is nothing to run.
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
      return yield* shellRun(guide.command);
    }),
  );
}

async function authTool(context: CliContext, id: string): Promise<number> {
  const runtime = await installCliProcessRuntime(context.storageRoot);
  return runtime.runPromise(
    Effect.gen(function* () {
      yield* initCliPlatform({ ...context, quietLogs: true });
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
      return yield* shellRun(guide.command);
    }),
  );
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

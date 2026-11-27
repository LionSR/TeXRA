import { Effect, Option } from 'effect';
import { Argument, Flag } from 'effect/cli';

import { programOrigin } from '@texra-ai/worldline/schemas';

import {
  failUsage,
  type CliContext,
  type CliInvocation,
} from '../runtime/platform/cliContext';
import { selectCliRunModel } from '../runtime/models/launchDefaults';
import { cliEntryAgent } from '../runtime/cliEntryAgent';
import {
  cliPlatform,
  type CliPlatform,
  type CliPlatformServices,
} from '../runtime/platform/initPlatform';

import {
  cliCommand,
  modelFlag,
  SKILL_SOURCES_CONFIG,
} from './_helpers/cliCommand';
import { emitCliResult } from '../runtime/platform/output';
import { resolveFileBackedInstruction } from './_helpers/instructionFile';
import {
  executeCliConfig,
  type CliExecuteOptions,
} from '../runtime/headless/executeCli';
import { formatToolUseAgentRunInstruction } from './_helpers/runInstructions';
import { toolUseResultText } from '../runtime/headless/terminalStatus';
import { withExpandedRunInputs } from '../runtime/headless/runInputs';
import type { Sessions } from '@texra-ai/worldline';
import {
  programLaunch,
  programsNow,
  type ProcessServices,
} from '@texra-ai/worldline/host';
import type { AgentConfigPayload } from '@texra-ai/worldline/schemas';

/** The `texra run` target that is no program: one answer from the entry
 *  agent, printed in the terminal. */
const CHAT_TARGET = 'chat';

interface HeadlessRunInit {
  /** A program's name, or {@link CHAT_TARGET}. */
  readonly target: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly model?: string;
  readonly instruction: string;
  readonly instructionFile?: string;
}

/**
 * `texra run <program | chat>`: the one headless run command. A name a
 * plugin registers as a program runs that program over `--input` files;
 * `chat` gives the entry agent a required instruction (`--instruction`,
 * `--instruction-file`, or both) and runs one model/tool cycle. Flags that
 * belong to the other shape are usage errors.
 */
export const runHeadlessAgent = Effect.fn('runHeadlessAgent')(function* (
  context: CliContext,
  init: HeadlessRunInit,
): Effect.fn.Return<
  number,
  Error,
  ProcessServices | Sessions | CliPlatform | CliInvocation
> {
  const instruction = yield* resolveFileBackedInstruction(init, context.cwd);
  // Nothing can run this: a program needs at least one input file, a chat
  // needs an instruction. Rejecting it before the
  // platform init keeps a plain usage error cheap.
  if (!instruction && init.inputFiles.length === 0) {
    return yield* failUsage(
      `Provide --instruction or --instruction-file for \`${CHAT_TARGET}\`, or --input for a program.`,
    );
  }

  const services = yield* cliPlatform;
  const { programs, withheld } = yield* programsNow(services.roots);
  const program = programs.get(init.target);
  if (program === undefined) {
    if (init.target !== CHAT_TARGET)
      return yield* failUsage(
        // A program read from a file may be one that does not load now.
        [
          `Unknown program: ${init.target}. Available: ${[...programs.keys()].toSorted().join(', ')}. Use \`${CHAT_TARGET}\` for a single-turn answer.`,
          ...(programOrigin(init.target) === 'listed' ? [] : withheld),
        ].join(' '),
      );
    return yield* runToolUseAgent(context, init, instruction, services);
  }

  return yield* withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    context.cwd,
    'program',
    Effect.fnUntraced(function* ({
      inputFiles,
      mediaFiles,
      contextFiles,
      writtenFiles,
    }) {
      const model = yield* selectCliRunModel(
        context,
        init.model,
        'run',
        services,
      );
      const launch = {
        model,
        inputFiles,
        mediaFiles,
        contextFiles,
        instruction,
        workingDirectory: context.cwd,
      };
      const config: AgentConfigPayload = {
        ...launch,
        ...(yield* programLaunch(init.target, {}, services.roots)),
      };

      return yield* executeCliRun(config, context, {
        services,
        recoveryInputIsDurable: writtenFiles.length === 0,
      });
    }),
  );
});

/**
 * The tool-use half of `texra run`: one model/tool cycle over the named
 * workspace files.
 */
const runToolUseAgent = Effect.fn('runToolUseAgent')(function* (
  context: CliContext,
  init: HeadlessRunInit,
  instruction: string,
  services: CliPlatformServices,
): Effect.fn.Return<number, Error, ProcessServices | CliInvocation> {
  if (!instruction) {
    return yield* failUsage('Provide --instruction or --instruction-file.');
  }

  const model = yield* selectCliRunModel(context, init.model, 'chat', services);

  return yield* withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    context.cwd,
    'agent',
    Effect.fnUntraced(function* ({
      inputFiles,
      mediaFiles,
      contextFiles,
      writtenFiles,
    }) {
      const config: AgentConfigPayload = {
        ...(yield* cliEntryAgent),
        model,
        inputFiles,
        mediaFiles,
        contextFiles,
        instruction: formatToolUseAgentRunInstruction({
          inputFiles,
          contextFiles,
          instruction,
        }),
        displayInstruction: instruction,
        workingDirectory: context.cwd,
      };

      return yield* executeCliRun(config, context, {
        services,
        recoveryInputIsDurable: writtenFiles.length === 0,
      });
    }),
  );
});

/**
 * Run a config headless through the shared CLI run skeleton and print its
 * result, the run's reply, in the requested format; the outcome is the exit
 * code. Shared by `texra run` (fresh runs) and `texra resume` (a program's
 * continuation under the persisted run id).
 */
export const executeCliRun = Effect.fn('executeCliRun')(function* (
  config: AgentConfigPayload,
  runContext: CliContext,
  options: CliExecuteOptions,
): Effect.fn.Return<number, Error, ProcessServices | CliInvocation> {
  const run = yield* executeCliConfig(config, runContext, options);
  if (!run.ok) return run.exitCode;

  yield* emitCliResult({
    json: run.result,
    ndjson: { kind: 'agent-result', result: run.result },
    text: toolUseResultText(run.result),
  });

  return run.exitCode;
});

const fileFlag = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withMetavar('file'),
    Flag.withDescription(description),
  );

export const headlessRunCommand = cliCommand('run', {
  description: 'Run a program, or one chat answer, headlessly',
  config: {
    ...SKILL_SOURCES_CONFIG,
    target: Argument.String('target').pipe(
      Argument.withDescription(
        `Program name, or \`${CHAT_TARGET}\` for a single-turn answer`,
      ),
    ),
    input: fileFlag(
      'input',
      'Text or supported media file passed to the agent (repeatable; use `-` for text stdin; required for programs)',
    ).pipe(Flag.withAlias('i'), Flag.atLeast(0)),
    context: fileFlag(
      'context',
      'Read-only context file passed to the agent (repeatable; use `-` to read stdin)',
    ).pipe(Flag.withAlias('c'), Flag.atLeast(0)),
    model: modelFlag('Model for the agent'),
    instruction: Flag.String('instruction').pipe(
      Flag.withDescription(
        'Instruction passed to the program or `chat` (`chat` needs this or --instruction-file)',
      ),
      Flag.optional,
    ),
    instructionFile: fileFlag(
      'instruction-file',
      'File whose contents are passed before --instruction when both are set',
    ).pipe(Flag.optional),
  },
  run: (context, input) =>
    runHeadlessAgent(context, {
      target: input.target,
      inputFiles: [...input.input],
      contextFiles: [...input.context],
      instruction: Option.getOrElse(input.instruction, () => ''),
      instructionFile: Option.getOrUndefined(input.instructionFile),
      model: Option.getOrUndefined(input.model),
    }),
});

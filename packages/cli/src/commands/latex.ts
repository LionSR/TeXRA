import {
  DEFAULT_MATH_MARKUP,
  MATH_MARKUP_OPTIONS,
  type MathMarkupOption,
} from '@latex/latexdiff/mathMarkup';
import { runLatexdiffForExecution } from '@latex/latexdiff/runLatexdiff';
import type {
  DiffProgressReporter,
  DiffRunResult,
} from '@latex/latexdiff/types';
import { checkToolInstalled } from '@utils/system';

import { CliExitCode } from '../runtime/exitCodes';
import { initLocalCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { withUsageSections } from './_helpers/dispatch';
import {
  collectStringFlagValues,
  GLOBAL_ARGS,
  optString,
} from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import { CliUsageError, type CliContext } from '../runtime/cliContext';

function resolveMathMarkup(value: string | undefined): MathMarkupOption {
  if (value === undefined) return DEFAULT_MATH_MARKUP;
  const match = MATH_MARKUP_OPTIONS.find((option) => option === value);
  if (!match) {
    throw new CliUsageError(
      `Invalid --math-markup "${value}". Expected one of: ${MATH_MARKUP_OPTIONS.join(', ')}.`,
    );
  }
  return match;
}

function formatResultLine(result: DiffRunResult): string {
  const suffix = result.description ? ` (${result.description})` : '';
  if (result.success) {
    return `  ✓ ${result.diffFileName ?? 'diff generated'}${suffix}`;
  }
  return `  ✗ ${result.message ?? 'Unknown error'}${suffix}`;
}

interface LatexdiffCliArgs {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles: string[];
  mathMarkup: MathMarkupOption;
  betweenRounds: boolean;
  runId?: string;
}

async function runLatexdiffCli(
  context: CliContext,
  args: LatexdiffCliArgs,
): Promise<number> {
  // Init first so platform logging is routed/quieted (`quietLogs`) before the
  // tool probe runs — otherwise its debug logs leak onto stdout and corrupt
  // `--output-format json|ndjson`.
  await initLocalCliPlatform(context);

  if (!(await checkToolInstalled('latexdiff', false))) {
    writeTextStderr(
      'latexdiff is not installed or not on PATH. Install it (e.g. with TeX Live or MacTeX) and try again.',
    );
    return CliExitCode.AgentError;
  }

  // Progress belongs on stderr so piped stdout (json/ndjson, `--print`) stays
  // byte-identical; only surface it in interactive text mode, and honor
  // `--quiet` like sibling commands.
  const progress: DiffProgressReporter = {
    report: ({ message }) => {
      if (message && context.outputFormat === 'text' && !context.quietLogs) {
        writeTextStderr(message);
      }
    },
  };

  const { outcome, executionId, source } = await runLatexdiffForExecution({
    agent: args.agent,
    model: args.model,
    inputFile: args.inputFile,
    outputFiles: args.outputFiles.length > 0 ? args.outputFiles : undefined,
    runId: args.runId,
    mathMarkup: args.mathMarkup,
    generateBetweenRoundDiffs: args.betweenRounds,
    progress,
  });

  const { results, totalOperations } = outcome;
  const successCount = results.filter((result) => result.success).length;

  const text =
    totalOperations === 0
      ? 'No LaTeX diff operations available for this run.'
      : [
          `${successCount}/${totalOperations} LaTeX diff(s) generated (math markup: ${args.mathMarkup}).`,
          ...results.map(formatResultLine),
        ].join('\n');

  const payload = {
    source,
    executionId: executionId ?? null,
    totalOperations,
    successCount,
    results,
  };
  emitCliResult(context, {
    json: payload,
    ndjson: { kind: 'result', result: { command: 'latexdiff', ...payload } },
    text,
  });

  // Exit non-zero only when there were operations and at least one failed, so
  // scripts can branch on a clean run; "nothing to diff" is a success.
  return successCount === totalOperations
    ? CliExitCode.Success
    : CliExitCode.AgentError;
}

export const latexdiffCommand = withUsageSections(
  defineCliCommand({
    meta: {
      name: 'latexdiff',
      description:
        "Generate round-aware LaTeX diffs for an agent run's outputs",
    },
    args: {
      ...GLOBAL_ARGS,
      name: {
        type: 'positional',
        required: true,
        description: 'Agent whose run outputs should be diffed',
      },
      model: {
        type: 'string',
        alias: 'm',
        description: 'Model the run used (identifies which outputs to diff)',
      },
      input: {
        type: 'string',
        alias: 'i',
        valueHint: 'file',
        description: 'Source LaTeX file the agent revised',
      },
      output: {
        type: 'string',
        alias: 'o',
        valueHint: 'file',
        description:
          'Output file to diff (repeatable; defaults to the --input file)',
      },
      'math-markup': {
        type: 'string',
        description: `Math markup mode: ${MATH_MARKUP_OPTIONS.join(' | ')} (default: ${DEFAULT_MATH_MARKUP})`,
      },
      'between-rounds': {
        type: 'boolean',
        description: 'Also generate diffs between consecutive rounds',
      },
      'run-id': {
        type: 'string',
        description: 'Scope output discovery to a specific execution id',
      },
    },
    run: (context, ctx) => {
      const model = optString(ctx.args.model);
      const inputFile = optString(ctx.args.input);
      if (!model || !inputFile) {
        throw new CliUsageError(
          'texra latexdiff requires --model and --input. See `texra latexdiff --help`.',
        );
      }
      return runLatexdiffCli(context, {
        agent: ctx.args.name,
        model,
        inputFile,
        outputFiles: collectStringFlagValues(ctx.rawArgs, 'output', 'o'),
        mathMarkup: resolveMathMarkup(optString(ctx.args['math-markup'])),
        betweenRounds: ctx.args['between-rounds'] === true,
        runId: optString(ctx.args['run-id']),
      });
    },
  }),
  [
    {
      title: 'EXAMPLES',
      rows: [
        [
          'texra latexdiff revise -m claude-opus-4-8 -i paper.tex',
          'diff the latest revise run of paper.tex against its pre-run base',
        ],
        [
          'texra latexdiff revise -m claude-opus-4-8 -i paper.tex --between-rounds',
          'also diff each round against the previous round',
        ],
      ],
    },
  ],
);

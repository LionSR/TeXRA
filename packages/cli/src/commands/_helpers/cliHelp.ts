// Third-party imports
import { Context, Effect, Layer } from 'effect';
import { CliOutput, type CliError, type HelpDoc } from 'effect/cli';

// Local imports - CLI
import { writeTextStderr, writeTextStdout } from '@cli/runtime/platform/logSinks';

interface UsageSection {
  readonly title: string;
  readonly rows: readonly (readonly [label: string, description: string])[];
}

/** Help sections a command adds below its flags (`Command.annotate`). */
export const UsageSections = Context.Reference<readonly UsageSection[]>(
  '@texra-ai/cli/UsageSections',
  { defaultValue: () => [] },
);

function formatUsageSection(section: UsageSection): string {
  if (section.rows.length === 0) return section.title;
  const labelWidth = Math.max(...section.rows.map(([label]) => label.length));
  return [
    section.title,
    ...section.rows.map(
      ([label, description]) => `  ${label.padEnd(labelWidth)}  ${description}`,
    ),
  ].join('\n');
}

function formatHelp(doc: HelpDoc.HelpDoc, colors: boolean): string {
  // The root lists every global flag; a subcommand names them in one line.
  const formatter = CliOutput.defaultFormatter({
    colors,
    globalFlags: (doc.commandPath?.length ?? 1) > 1 ? 'summary' : 'full',
  });
  const sections = Context.get(doc.annotations, UsageSections);
  return [formatter.formatHelpDoc(doc), ...sections.map(formatUsageSection)]
    .join('\n\n')
    .trimEnd();
}

function usagePointer(commandPath: readonly string[]): string {
  return `Run \`${commandPath.join(' ')} --help\` for usage.`;
}

const isUnknownName = (error: CliError.CliError): boolean =>
  error._tag === 'UnknownSubcommand' || error._tag === 'UnrecognizedOption';

function formatInvocationError(error: CliError.CliError): string {
  switch (error._tag) {
    case 'UnknownSubcommand': {
      const parent = error.parent ?? [];
      const typed = [...parent, error.subcommand].join(' ');
      const suggestion = error.suggestions[0];
      return suggestion === undefined
        ? `Unknown command: ${typed}.`
        : `Unknown command: ${typed}. Did you mean \`${[...parent, suggestion].join(' ')}\`?`;
    }
    case 'UnrecognizedOption': {
      const suggestion = error.suggestions[0];
      return suggestion === undefined
        ? `Unknown option: ${error.option}.`
        : `Unknown option: ${error.option}. Did you mean \`${suggestion}\`?`;
    }
    default:
      return error.message;
  }
}

/**
 * The CLI's help and usage-error output: help to stdout, a usage error as
 * its message and a pointer to `--help` on stderr, so stdout stays clean
 * under `--output-format json|ndjson`. A group named without a subcommand
 * says so the same way.
 */
export const cliPresenterLayer = (colors: boolean) =>
  Layer.succeed(CliOutput.Presenter)({
    present: (event) =>
      Effect.sync(() => {
        switch (event._tag) {
          case 'Help':
            if (event.reason === 'Implicit' && event.commandPath.length > 1) {
              writeTextStderr(
                `No command specified.\n${usagePointer(event.commandPath)}`,
              );
              return;
            }
            writeTextStdout(formatHelp(event.helpDoc, colors));
            return;
          case 'InvalidInvocation':
            // An unknown name reads as one line, as it always has.
            writeTextStderr(
              event.errors.map(formatInvocationError).join('\n') +
                (event.errors.every(isUnknownName) ? ' ' : '\n') +
                usagePointer(event.commandPath),
            );
            return;
          case 'Version':
            writeTextStdout(event.version);
        }
      }),
  });

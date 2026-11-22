import { Effect } from 'effect';
import { Command } from 'effect/cli';

import { Skills } from '@texra-ai/worldline/host';

import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliPlatform } from '../runtime/platform/initPlatform';
import { writeTextStderr } from '../runtime/platform/logSinks';
import {
  formatCliSkillIssue,
  formatCliSkillList,
  readCliSkillsOffNotice,
} from '../runtime/skills';

import { SKILL_SOURCES_CONFIG, cliCommand } from './_helpers/cliCommand';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/platform/cliContext';

const listSkills = Effect.fn('listSkills')(function* (
  context: CliContext,
  options: {
    readonly additionalPaths: readonly string[];
  },
) {
  const services = yield* cliPlatform;
  const roots = services.roots;
  const result = yield* Skills.enabled(roots, options);
  const exitCode = result.issues.some((issue) => issue.code === 'source_error')
    ? CliExitCode.Usage
    : CliExitCode.Success;

  // Parse errors surface on stderr for json + text (NDJSON consumers get
  // them as `kind: skill-issue` records instead), so the stdout contract
  // stays scriptable with `jq '.[]'`.
  if (context.outputFormat !== 'ndjson') {
    for (const issue of result.issues) {
      writeTextStderr(formatCliSkillIssue(issue));
    }
    const offNotice = yield* readCliSkillsOffNotice(
      roots,
      '`texra config edit`',
    );
    if (offNotice !== undefined) writeTextStderr(offNotice);
  }

  // Emit the bare-array JSON / per-line NDJSON shape every other
  // `<resource> list` command produces, via the shared emitCliResult
  // helper. The text list is suppressed on a usage error with no skills
  // (nothing useful to show); the helper skips the write for the
  // resulting empty string.
  yield* emitCliResult({
    json: result.skills,
    ndjson: [
      ...result.skills.map((skill) => ({ kind: 'skill' as const, skill })),
      ...result.issues.map((issue) => ({
        kind: 'skill-issue' as const,
        issue,
      })),
    ],
    text:
      exitCode === CliExitCode.Success || result.skills.length > 0
        ? formatCliSkillList(result.skills)
        : '',
  });
  return exitCode;
});

const skillsListCommand = cliCommand('list', {
  description: 'List available skills',
  config: { ...SKILL_SOURCES_CONFIG },
  run: (context, input) =>
    listSkills(context, { additionalPaths: input.skillSources }),
});

export const skillsCommand = Command.make('skills').pipe(
  Command.withDescription('Inspect TeXRA skills'),
  Command.withSubcommands([skillsListCommand]),
);

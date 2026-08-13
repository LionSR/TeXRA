import { defineCommand } from 'citty';

import { CliExitCode } from '../runtime/exitCodes';
import { writeTextStderr } from '../runtime/logSinks';
import {
  formatCliSkillIssue,
  formatCliSkillList,
  readCliSkills,
  skillListRecord,
} from '../runtime/skills';

import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  GLOBAL_ARGS,
  SKILL_SOURCE_ARGS,
  collectStringFlagValues,
} from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

async function listSkills(
  context: CliContext,
  options: {
    readonly includeInterop: boolean;
    readonly additionalPaths: readonly string[];
  },
): Promise<number> {
  const result = await readCliSkills(context, options);
  const exitCode = result.errors.some(
    (issue) =>
      issue.code === 'missing_source' ||
      issue.code === 'invalid_source' ||
      issue.code === 'source_read_error',
  )
    ? CliExitCode.Usage
    : CliExitCode.Success;

  // Parse errors surface on stderr for json + text (NDJSON consumers get them
  // as `kind: skill-issue` records instead), so the stdout contract stays
  // scriptable with `jq '.[]'`.
  if (context.outputFormat !== 'ndjson') {
    for (const issue of result.errors) {
      writeTextStderr(formatCliSkillIssue(issue));
    }
  }

  // Emit the bare-array JSON / per-line NDJSON shape every other
  // `<resource> list` command produces, via the shared emitCliResult helper.
  // The text list is suppressed on a usage error with no skills (nothing
  // useful to show); the helper skips the write for the resulting empty string.
  emitCliResult(context, {
    json: result.skills.map(skillListRecord),
    ndjson: [
      ...result.skills.map((entry) => ({
        kind: 'skill' as const,
        skill: skillListRecord(entry),
      })),
      ...result.errors.map((issue) => ({
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
}

const skillsListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List available skills' },
  args: {
    ...GLOBAL_ARGS,
    ...SKILL_SOURCE_ARGS,
  },
  run: (context, ctx) =>
    listSkills(context, {
      includeInterop: ctx.args['include-interop'] === true,
      additionalPaths: collectStringFlagValues(ctx.rawArgs, 'source', 's'),
    }),
});

export const skillsCommand = defineCommand({
  meta: { name: 'skills', description: 'Inspect TeXRA skills' },
  subCommands: { list: skillsListCommand },
});

import { defineCommand } from 'citty';

import { CliExitCode } from '../runtime/exitCodes';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
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

  if (context.outputFormat === 'json') {
    // Match the bare-array JSON shape every other `<resource> list` command
    // emits (agents, models, multi-agent, history, tools). Parse errors are
    // surfaced on stderr below (same as the text branch) so the stdout
    // contract stays scriptable with `jq '.[]'`. NDJSON consumers still get
    // structured `kind: skill-issue` records for the same errors.
    for (const issue of result.errors) {
      writeTextStderr(formatCliSkillIssue(issue));
    }
    writeTextStdout(
      JSON.stringify(result.skills.map(skillListRecord), null, 2),
    );
    return exitCode;
  }

  if (context.outputFormat === 'ndjson') {
    const ts = new Date().toISOString();
    for (const entry of result.skills) {
      writeNdjsonStdout({
        kind: 'skill',
        ts,
        skill: skillListRecord(entry),
      });
    }
    for (const issue of result.errors) {
      writeNdjsonStdout({ kind: 'skill-issue', ts, issue });
    }
    return exitCode;
  }

  for (const issue of result.errors) {
    writeTextStderr(formatCliSkillIssue(issue));
  }
  if (exitCode === CliExitCode.Success || result.skills.length > 0) {
    writeTextStdout(formatCliSkillList(result.skills));
  }
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

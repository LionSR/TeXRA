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

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS, collectStringFlagValues } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/cliContext';

async function listSkills(
  context: CliContext,
  options: {
    readonly includeInterop: boolean;
    readonly additionalPaths: readonly string[];
  },
): Promise<number> {
  const result = await readCliSkills(context, options);

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
    return CliExitCode.Success;
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
    return CliExitCode.Success;
  }

  for (const issue of result.errors) {
    writeTextStderr(formatCliSkillIssue(issue));
  }
  writeTextStdout(formatCliSkillList(result.skills));
  return CliExitCode.Success;
}

const skillsListCommand = defineCommand({
  meta: { name: 'list', description: 'List available skills' },
  args: {
    ...GLOBAL_ARGS,
    'include-interop': {
      type: 'boolean',
      description:
        'Also scan .claude/skills, .codex/skills, and .gemini/skills under the workspace and home directory',
    },
    source: {
      type: 'string',
      alias: 's',
      description:
        'Additional skill root to scan; may be repeated and is resolved relative to --cwd',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(
      await listSkills(context, {
        includeInterop: ctx.args['include-interop'] === true,
        additionalPaths: collectStringFlagValues(ctx.rawArgs, 'source', 's'),
      }),
    );
  },
});

export const skillsCommand = defineCommand({
  meta: { name: 'skills', description: 'Inspect TeXRA skills' },
  subCommands: { list: skillsListCommand },
});

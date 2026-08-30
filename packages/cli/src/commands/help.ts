import { defineCommand } from 'citty';

import { setExitCode } from './_helpers/exitCode';

export const helpCommand = defineCommand({
  meta: { name: 'help', description: 'Show TeXRA CLI commands' },
  async run(ctx) {
    // `texra help <path...>` is `texra <path...> --help`: re-enter the root
    // dispatcher, which owns unknown-command detection and usage rendering.
    const { runCli } = await import('./root');
    const { exitCode } = await runCli([...ctx.rawArgs, '--help']);
    setExitCode(exitCode);
  },
});

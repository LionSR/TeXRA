import { defineCommand, showUsage } from 'citty';

export const helpCommand = defineCommand({
  meta: { name: 'help', description: 'Show TeXRA CLI commands' },
  async run() {
    const { rootCommand } = await import('./root');
    await showUsage(rootCommand);
  },
});

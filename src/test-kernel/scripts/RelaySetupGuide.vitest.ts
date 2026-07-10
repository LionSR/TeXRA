// Node imports
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Third-party imports
import MarkdownIt from 'markdown-it';
import { parse as parseShell } from 'shell-quote';
import { describe, expect, it } from 'vitest';

interface ParsedCommand {
  source: string;
  tokens: string[];
}

const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh']);
const RELEVANT_COMMAND =
  /\b(?:export\s+SUPABASE_PROJECT_REF=|node\s+scripts\/deploy-relay\.mjs\b|supabase\s+secrets\s+set\b)/;

const guidePath = fileURLToPath(
  new URL('../../../docs/supabase/RELAY_SETUP.md', import.meta.url),
);
const guide = readFileSync(guidePath, 'utf8');

function parseRelevantCommands(markdown: string): ParsedCommand[] {
  const commandBlocks = new MarkdownIt().parse(markdown, {}).filter((token) => {
    if (token.type === 'code_block') return true;
    const language = token.info.trim().split(/\s+/, 1)[0];
    return token.type === 'fence' && SHELL_LANGUAGES.has(language);
  });

  return commandBlocks.flatMap((block) =>
    block.content
      .replaceAll(/\\\r?\n[ \t]*/g, ' ')
      .split(/\r?\n/)
      .map((source) => source.trim())
      .filter(
        (source) => !source.startsWith('#') && RELEVANT_COMMAND.test(source),
      )
      .map((source) => ({
        source,
        tokens: parseShell(source, (name) => `$${name}`).filter(
          (token): token is string => typeof token === 'string',
        ),
      })),
  );
}

describe('Relay setup guide', () => {
  const commands = parseRelevantCommands(guide);

  it('exports one project reference before deploying the relay', () => {
    const exportIndexes = commands
      .map(({ tokens }, index) => ({ index, tokens }))
      .filter(
        ({ tokens }) =>
          tokens[0] === 'export' &&
          tokens.some((token) => token.startsWith('SUPABASE_PROJECT_REF=')),
      )
      .map(({ index }) => index);

    expect(exportIndexes).toEqual([expect.any(Number)]);
    const deployIndex = commands.findIndex(
      ({ tokens }) =>
        tokens[0] === 'node' && tokens[1] === 'scripts/deploy-relay.mjs',
    );
    expect(deployIndex).toBeGreaterThan(exportIndexes[0] ?? Number.MAX_VALUE);
  });

  it('passes the exported project reference to every secrets set command', () => {
    const secretCommands = commands.filter(
      ({ tokens }) =>
        tokens[0] === 'supabase' &&
        tokens[1] === 'secrets' &&
        tokens[2] === 'set',
    );

    expect(secretCommands.length).toBeGreaterThan(0);
    for (const command of secretCommands) {
      const flagIndex = command.tokens.indexOf('--project-ref', 3);
      expect(
        flagIndex,
        `missing --project-ref in: ${command.source}`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        command.tokens[flagIndex + 1],
        `wrong project reference in: ${command.source}`,
      ).toBe('$SUPABASE_PROJECT_REF');
    }
  });
});

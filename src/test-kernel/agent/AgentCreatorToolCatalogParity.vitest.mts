// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

import { TOOL_GROUPS } from '@agent/implementations/flows/agentCreator/agentCreatorFlow';

// TOOL_GROUPS (the code owner consulted by the agent-creator UI's tool
// picker) and the human-facing tool catalog doc are two hand-maintained
// copies of the same tool-to-category grouping. They must agree, or the
// picker and the docs silently disagree about which tools live where.
const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const CATALOG_PATH = resolve(
  REPO_ROOT,
  'packages/extension/resources/docs/agent-creation/tool_catalog.md',
);

// Sections that describe per-tool "recommended combos" or prose guidance
// rather than the canonical per-category tool lists — not compared.
const IGNORED_SECTIONS = new Set([
  'recommended tool groups by use case',
  'system prompt best practices',
]);

/** Parses the `## Category` sections of tool_catalog.md into tool-name sets. */
function parseCatalogGroups(markdown: string): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  const sections = markdown.split(/^## /m).slice(1);

  for (const section of sections) {
    const newlineIndex = section.indexOf('\n');
    const header = section.slice(0, newlineIndex).trim().toLowerCase();
    if (IGNORED_SECTIONS.has(header)) continue;

    // Bullets in the doc soft-wrap across lines (continuation lines are
    // indented, not re-prefixed with "- "); rejoin them before splitting
    // into logical bullet lines so wrapped tool names aren't dropped.
    const body = section.slice(newlineIndex + 1).replace(/\n +(?=\S)/g, ' ');
    const tools = new Set<string>();
    for (const line of body.split('\n')) {
      if (!line.trimStart().startsWith('- ')) continue;
      // Only the tool-name list before the em-dash description counts —
      // parameter names quoted later in the sentence (e.g. `agent`, `model`)
      // are not tool names.
      const [toolList] = line.split(' — ');
      for (const match of toolList.matchAll(/`([a-z0-9_]+)`/g)) {
        tools.add(match[1]);
      }
    }
    groups.set(header, tools);
  }

  return groups;
}

describe('agent-creator TOOL_GROUPS vs tool_catalog.md', () => {
  const catalogGroups = parseCatalogGroups(readFileSync(CATALOG_PATH, 'utf8'));

  it('lists every TOOL_GROUPS category in the doc', () => {
    for (const label of Object.keys(TOOL_GROUPS)) {
      expect(catalogGroups.has(label.toLowerCase())).toBe(true);
    }
  });

  it.each(Object.entries(TOOL_GROUPS))(
    '%s: TOOL_GROUPS tools match tool_catalog.md',
    (label, group) => {
      const docTools = catalogGroups.get(label.toLowerCase());
      expect(docTools).toBeDefined();
      expect(new Set(group.tools)).toEqual(docTools);
    },
  );
});

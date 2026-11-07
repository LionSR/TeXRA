// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { codemode } from '@tools/builtinPlugins';
import { texraPlugins } from '@texra/tools/registry';

/** The creator agent's reference for which tools an agent can be granted. */
const CATALOG = new URL(
  '../../../packages/extension/resources/docs/agent-creation/tool_catalog.md',
  import.meta.url,
);

describe('the creator agent tool catalog', () => {
  // The catalog is prose the creator reads, so it is not generated; its
  // names are held to the registry here instead, so a renamed or removed
  // tool cannot stay listed.
  it('names only tools the registry has', () => {
    const registered = new Set(
      [codemode, ...texraPlugins({ name: 'vscode', inquiryPanel: true })]
        .flatMap((plugin) => plugin.tools ?? [])
        .map((tool) => tool.definition.name),
    );
    const listed = [
      ...readFileSync(CATALOG, 'utf8').matchAll(/^- `([a-z0-9_]+)`/gm),
    ].map((match) => match[1]);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((name) => !registered.has(name))).toEqual([]);
  });
});

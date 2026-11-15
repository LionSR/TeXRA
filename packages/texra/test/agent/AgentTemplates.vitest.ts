import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  AGENT_TEMPLATE_FILE,
  agentFileFromTemplate,
} from '@texra/agent/templates/agentTemplates';

describe('agentFileFromTemplate', () => {
  // The prompt template renders when the agent runs, so creating the file
  // must leave its placeholders as written.
  it('writes the chat template with only its name and description changed', () => {
    const raw = readFileSync(
      path.join(
        process.cwd(),
        'packages/extension/resources/templates',
        AGENT_TEMPLATE_FILE,
      ),
      'utf8',
    );

    const written = parse(
      agentFileFromTemplate(raw, {
        name: 'my_agent',
        description: "an agent's description",
      }),
    );

    expect(written).toStrictEqual({
      ...parse(raw),
      name: 'my_agent',
      description: "an agent's description",
    });
  });
});

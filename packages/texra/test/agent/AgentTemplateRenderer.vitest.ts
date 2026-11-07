import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  AGENT_TEMPLATE_FILES,
  agentFileFromTemplate,
} from '@texra/agent/templates/agentTemplateRenderer';

describe('agentFileFromTemplate', () => {
  // A task's templates render when it runs, over the run's files. Rendered
  // at creation, a loop over `INPUT_FILES` walked the characters of its
  // placeholder and asked for documents named `{`, `I`, `N`, ….
  it('writes the document task template with only its name and description changed', () => {
    const raw = readFileSync(
      path.join(
        process.cwd(),
        'packages/extension/resources/templates',
        AGENT_TEMPLATE_FILES.workflowSingle,
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

// Standard library imports
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Local imports
import {
  createAgentOptionTag,
  createGroupedAgentOptionMarkup,
  AGENT_OPTION_GROUP_LABELS,
  getAgentOptionMetadata,
  type AgentDirectoryMap,
} from '@agent/utils/agentOptionMetadata';

describe('agentOptionMetadata', () => {
  let tempDir: string;
  let directories: AgentDirectoryMap;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-meta-'));
    directories = { custom: tempDir };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('marks agents that declare isMultipleOutput as multi', () => {
    const agentPath = path.join(tempDir, 'custom_multi.yaml');
    fs.writeFileSync(
      agentPath,
      ['name: custom_multi', 'settings:', '  isMultipleOutput: true'].join(
        '\n',
      ),
      'utf8',
    );

    const metadata = getAgentOptionMetadata('custom_multi', directories);
    assert.equal(metadata.isMultipleOutput, true);
    const optionTag = createAgentOptionTag('custom_multi', metadata);
    assert.ok(optionTag.includes('data-multiple="true"'));
    assert.ok(optionTag.includes('∶∶'));
  });

  it('keeps base agents decorated when a sibling _multiple file exists', () => {
    const basePath = path.join(tempDir, 'writer.yaml');
    const multiplePath = path.join(tempDir, 'writer_multiple.yaml');
    fs.writeFileSync(
      basePath,
      ['name: writer', 'settings:', '  prefills: []'].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      multiplePath,
      ['name: writer_multiple', 'settings:', '  isMultipleOutput: true'].join(
        '\n',
      ),
      'utf8',
    );

    const metadata = getAgentOptionMetadata('writer', directories);
    assert.equal(metadata.hasMultipleSibling, true);
    const optionTag = createAgentOptionTag('writer', metadata);
    assert.ok(optionTag.includes('data-multiple="true"'));
    assert.ok(optionTag.includes('∶∶'));
  });

  it('wraps workflow and tool-use agents in separate optgroups', () => {
    const workflowAgent = 'workflow_agent';
    const toolAgent = 'tool_agent';

    fs.writeFileSync(
      path.join(tempDir, `${workflowAgent}.yaml`),
      ['name: workflow_agent', 'settings:', '  agentType: direct'].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(tempDir, `${toolAgent}.yaml`),
      ['name: tool_agent', 'settings:', '  agentType: toolUse'].join('\n'),
      'utf8',
    );

    const entries = [workflowAgent, toolAgent].map((agentName) => ({
      agentName,
      metadata: getAgentOptionMetadata(agentName, directories),
    }));

    const markup = createGroupedAgentOptionMarkup(entries);

    assert.ok(markup.includes('<optgroup'));
    assert.ok(markup.includes(`label="${AGENT_OPTION_GROUP_LABELS.workflow}"`));
    assert.ok(markup.includes(`label="${AGENT_OPTION_GROUP_LABELS.toolUse}"`));

    const workflowGroupIndex = markup.indexOf('agent-group--workflow');
    const toolUseGroupIndex = markup.indexOf('agent-group--tool-use');
    assert.ok(workflowGroupIndex >= 0, 'workflow group should exist');
    assert.ok(
      toolUseGroupIndex > workflowGroupIndex,
      'tool-use group should follow workflows',
    );

    assert.ok(markup.includes(`value="${workflowAgent}"`));
    assert.ok(markup.includes(`value="${toolAgent}"`));
  });
});

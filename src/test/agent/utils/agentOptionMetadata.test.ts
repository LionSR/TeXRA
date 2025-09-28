// Standard library imports
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Local imports
import {
  createAgentOptionTag,
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
      [
        'name: custom_multi',
        'settings:',
        '  isMultipleOutput: true',
      ].join('\n'),
      'utf8',
    );

    const metadata = getAgentOptionMetadata('custom_multi', directories);
    assert.equal(metadata.isMultipleOutput, true);
    const optionTag = createAgentOptionTag('custom_multi', metadata);
    assert.ok(optionTag.includes('data-multiple="true"'));
    assert.ok(optionTag.includes('∶∶'));
  });

  it('normalizes legacy useMultipleOutputs declarations', () => {
    const agentPath = path.join(tempDir, 'legacy_multi.yaml');
    fs.writeFileSync(
      agentPath,
      [
        'name: legacy_multi',
        'settings:',
        '  useMultipleOutputs: true',
      ].join('\n'),
      'utf8',
    );

    const metadata = getAgentOptionMetadata('legacy_multi', directories);
    assert.equal(metadata.isMultipleOutput, true);
  });

  it('keeps base agents decorated when a sibling _multiple file exists', () => {
    const basePath = path.join(tempDir, 'writer.yaml');
    const multiplePath = path.join(tempDir, 'writer_multiple.yaml');
    fs.writeFileSync(basePath, ['name: writer', 'settings:', '  prefills: []'].join('\n'), 'utf8');
    fs.writeFileSync(
      multiplePath,
      [
        'name: writer_multiple',
        'settings:',
        '  isMultipleOutput: true',
      ].join('\n'),
      'utf8',
    );

    const metadata = getAgentOptionMetadata('writer', directories);
    assert.equal(metadata.hasMultipleSibling, true);
    const optionTag = createAgentOptionTag('writer', metadata);
    assert.ok(optionTag.includes('data-multiple="true"'));
    assert.ok(optionTag.includes('∶∶'));
  });
});

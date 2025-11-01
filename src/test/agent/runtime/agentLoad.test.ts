// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

// Local imports - agent runtime
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import { AgentDirectorySource } from '@agent/runtime/AgentPathTypes';
import { DEFAULT_TOOL_REGISTRY } from '@tools/registry';
import { AbsoluteFS } from '@utils/files';

suite('loadAgentSettingAndPrompts', () => {
  const absoluteFsAny = AbsoluteFS as unknown as {
    exists: (filePath: string) => Promise<boolean>;
    read: (filePath: string) => Promise<string>;
  };
  const originalExists = absoluteFsAny.exists;
  const originalRead = absoluteFsAny.read;

  const fileContents = new Map<string, string>();

  function normalize(filePath: string): string {
    return path.normalize(filePath);
  }

  setup(() => {
    fileContents.clear();

    absoluteFsAny.exists = async (filePath: string) =>
      fileContents.has(normalize(filePath));

    absoluteFsAny.read = async (filePath: string) => {
      const normalized = normalize(filePath);
      const content = fileContents.get(normalized);
      if (!content) {
        throw new Error(`File not found: ${filePath}`);
      }
      return content;
    };
  });

  teardown(() => {
    absoluteFsAny.exists = originalExists;
    absoluteFsAny.read = originalRead;
  });

  test('uses the _multiple definition when available', async () => {
    const agentPath = path.join('/', 'tmp', 'agents');
    const baseDefinitionPath = path.join(agentPath, 'polish.yaml');
    const multipleDefinitionPath = path.join(agentPath, 'polish_multiple.yaml');
    const agentPathInfo = {
      directory: agentPath,
      source: AgentDirectorySource.Custom,
    } as const;

    fileContents.set(
      normalize(multipleDefinitionPath),
      [
        'name: polish_multiple',
        'settings:',
        '  agentType: direct',
        'prompts:',
        '  userRequest: multiple variant',
        '',
      ].join('\n'),
    );

    fileContents.set(
      normalize(baseDefinitionPath),
      [
        'name: polish',
        'settings:',
        '  agentType: direct',
        'prompts:',
        '  userRequest: base variant',
        '',
      ].join('\n'),
    );

    const [, prompts] = await loadAgentSettingAndPrompts(
      agentPathInfo,
      'polish',
      {
        preferMultiple: true,
      },
    );

    assert.strictEqual(prompts.userRequest, 'multiple variant');
  });

  test('falls back to the base definition when _multiple is missing', async () => {
    const agentPath = path.join('/', 'tmp', 'agents');
    const baseDefinitionPath = path.join(agentPath, 'summarize.yaml');
    const agentPathInfo = {
      directory: agentPath,
      source: AgentDirectorySource.Custom,
    } as const;

    fileContents.set(
      normalize(baseDefinitionPath),
      [
        'name: summarize',
        'settings:',
        '  agentType: direct',
        'prompts:',
        '  userRequest: base only',
        '',
      ].join('\n'),
    );

    const [, prompts] = await loadAgentSettingAndPrompts(
      agentPathInfo,
      'summarize',
      {
        preferMultiple: true,
      },
    );

    assert.strictEqual(prompts.userRequest, 'base only');
  });

  test('merges inherited settings and resolves tool registry entries', async () => {
    const agentPath = path.join('/', 'tmp', 'agents');
    const baseDefinitionPath = path.join(agentPath, 'base.yaml');
    const childDefinitionPath = path.join(agentPath, 'child.yaml');
    const agentPathInfo = {
      directory: agentPath,
      source: AgentDirectorySource.Custom,
    } as const;

    fileContents.set(
      normalize(baseDefinitionPath),
      [
        'name: base',
        'settings:',
        '  agentType: direct',
        '  documentTag: parentDoc',
        '  requiredFiles:',
        '    shared: shared.tex',
        '  defaultOutputFiles:',
        '    - parent.txt',
        '  tools:',
        '    - str_replace_editor',
        'prompts:',
        '  systemPrompt: Parent system prompt',
        '  userRequest:',
        '    - base request',
        '',
      ].join('\n'),
    );

    fileContents.set(
      normalize(childDefinitionPath),
      [
        'name: child',
        'inherits: base',
        'settings:',
        '  endTag: </custom>',
        '  requiredFiles:',
        '    child: child.tex',
        '  defaultOutputFiles:',
        '    - child.txt',
        'prompts:',
        '  userRequest:',
        '    - child request',
        '',
      ].join('\n'),
    );

    const [settings, prompts] = await loadAgentSettingAndPrompts(
      agentPathInfo,
      'child',
    );

    assert.strictEqual(settings.documentTag, 'parentDoc');
    assert.strictEqual(settings.endTag, '</custom>');
    assert.deepEqual(settings.requiredFiles, {
      shared: 'shared.tex',
      child: 'child.tex',
    });
    assert.deepEqual(settings.defaultOutputFiles, ['child.txt']);
    assert.strictEqual(prompts.systemPrompt, 'Parent system prompt');
    assert.deepEqual(prompts.userRequest, ['child request']);

    const resolvedTool = settings.tools?.[0];
    assert.ok(resolvedTool, 'expected inherited tool to be present');
    assert.strictEqual(
      resolvedTool,
      DEFAULT_TOOL_REGISTRY.str_replace_editor.definition,
    );
  });
});

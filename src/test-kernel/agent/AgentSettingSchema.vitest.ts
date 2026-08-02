import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';

import {
  AgentCategory,
  AgentDefinitionSchema,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';
import { REPO_ROOT } from '@test/support/repoScan';

/**
 * Run `parse` with `console.warn` silenced and report how many deprecation
 * warnings it fired. The count is read before `mockRestore()`, which implies
 * `mockReset()` and would clear `mock.calls` first.
 */
function withWarningCount<T>(parse: () => T): { result: T; warnings: number } {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = parse();
    return { result, warnings: warnSpy.mock.calls.length };
  } finally {
    warnSpy.mockRestore();
  }
}

describe('AgentSettingSchema', () => {
  it('strips legacy workflow outputExt without exposing it in settings', () => {
    const setting = AgentSettingSchema.parse({
      agentCategory: AgentCategory.Workflow,
      outputExt: 'tex',
    });

    expect(setting.agentCategory).toBe(AgentCategory.Workflow);
    expect(Object.hasOwn(setting, 'outputExt')).toBe(false);
  });

  it.each([
    {
      scenario: 'warns once per retired setting that carried a value',
      legacy: {
        internal: true,
        requiredFiles: { TEMPLATE: 'templates/main.tex' },
        filePatternsContain: [{ pattern: 'bibliography', varName: 'BIB' }],
      },
      expectedWarnings: 3,
    },
    {
      scenario: 'drops materialized empty retired settings silently',
      legacy: { requiredFiles: {}, filePatternsContain: [] },
      expectedWarnings: 0,
    },
  ])('$scenario', ({ legacy, expectedWarnings }) => {
    const { result: setting, warnings } = withWarningCount(() =>
      AgentSettingSchema.parse({
        agentCategory: AgentCategory.Workflow,
        ...legacy,
      }),
    );

    for (const key of Object.keys(legacy)) {
      expect(Object.hasOwn(setting, key)).toBe(false);
    }
    expect(warnings).toBe(expectedWarnings);
  });

  it('regression #7497: public remote agent YAML no longer carries documentTag/endTag', () => {
    // The retired keys used to be copy-pasted into every remote agent, so
    // parsing the bundle at startup fired the deprecation console.warn 4-8x
    // on every launch. Assert both the absence of the keys and the silent
    // parse, so a re-added key fails loudly here instead of in users' stderr.
    const dir = resolve(REPO_ROOT, 'prompts/agents/remote');
    const files = readdirSync(dir).filter((name) => name.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);

    const { warnings } = withWarningCount(() => {
      for (const file of files) {
        const raw = yaml.parse(readFileSync(resolve(dir, file), 'utf8'));
        AgentDefinitionSchema.parse(raw);
      }
    });
    expect(warnings).toBe(0);
  });
});

describe('AgentDefinitionSchema', () => {
  it('keeps inherited child settings and prompts partial before merging', () => {
    const result = AgentDefinitionSchema.parse({
      name: 'child',
      inherits: 'parent',
      settings: {
        tools: ['grep'],
      },
      prompts: {
        userRequest: 'Do the thing',
      },
    });

    expect(result.settings).toEqual({ tools: ['grep'] });
    expect(Object.hasOwn(result.settings, 'rounds')).toBe(false);
    expect(Object.hasOwn(result.settings, 'agentCategory')).toBe(false);
    expect(result.prompts).toEqual({ userRequest: 'Do the thing' });
    expect(Object.hasOwn(result.prompts, 'systemPrompt')).toBe(false);
  });

  it('accepts inherited children that omit settings and prompts blocks', () => {
    const result = AgentDefinitionSchema.parse({
      name: 'child',
      inherits: 'parent',
    });

    expect(result.settings).toEqual({});
    expect(result.prompts).toEqual({});
  });

  it('preserves inherited defaults until the post-merge final parse', () => {
    const parentSettings = AgentSettingSchema.parse({
      agentCategory: AgentCategory.Workflow,
      rounds: 5,
      tools: [{ name: 'grep' }],
    });
    const parentPrompts = AgentPromptSchema.parse({
      systemPrompt: 'You are careful.',
      userRequest: 'Parent request',
    });
    const child = AgentDefinitionSchema.parse({
      name: 'child',
      inherits: 'parent',
      prompts: {
        userRequest: 'Child request',
      },
    });

    const settings = AgentSettingSchema.parse(
      mergeInheritedAgentObject(parentSettings, child.settings),
    );
    const prompts = AgentPromptSchema.parse(
      mergeInheritedAgentObject(parentPrompts, child.prompts),
    );

    expect(settings.agentCategory).toBe(AgentCategory.Workflow);
    if (settings.agentCategory !== AgentCategory.Workflow) {
      throw new Error('expected workflow settings');
    }
    expect(settings.rounds).toBe(5);
    expect(settings.tools).toEqual([{ name: 'grep' }]);
    expect(prompts.systemPrompt).toBe('You are careful.');
    expect(prompts.userRequest).toBe('Child request');
  });

  it('rejects unknown top-level metadata', () => {
    const result = AgentDefinitionSchema.safeParse({
      name: 'assistant',
      title: 'Assistant',
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('unknown metadata should not be valid');
    }
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['title'],
      }),
    ]);
  });

  it('rejects names that are not identifiers', () => {
    expect(() =>
      AgentDefinitionSchema.parse({
        name: 'review team',
      }),
    ).toThrow('Agent names must be identifiers');
  });
});

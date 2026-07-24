import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';

import {
  AgentCategory,
  AgentDefinitionSchema,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

describe('AgentSettingSchema', () => {
  it('strips legacy workflow outputExt without exposing it in settings', () => {
    const setting = AgentSettingSchema.parse({
      agentCategory: AgentCategory.Workflow,
      outputExt: 'tex',
    });

    expect(setting.agentCategory).toBe(AgentCategory.Workflow);
    expect(Object.hasOwn(setting, 'outputExt')).toBe(false);
  });

  it('ignores default legacy documentTag/endTag without warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let setting!: ReturnType<typeof AgentSettingSchema.parse>;
    let warningCount = 0;
    try {
      setting = AgentSettingSchema.parse({
        agentCategory: AgentCategory.Workflow,
        documentTag: 'documents',
        endTag: '</documents>',
      });
      warningCount = warnSpy.mock.calls.length;
    } finally {
      warnSpy.mockRestore();
    }

    expect(setting.agentCategory).toBe(AgentCategory.Workflow);
    expect(Object.hasOwn(setting, 'documentTag')).toBe(false);
    expect(Object.hasOwn(setting, 'endTag')).toBe(false);
    expect(warningCount).toBe(0);
  });

  it('warns when stripping bespoke legacy documentTag/endTag values', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let setting!: ReturnType<typeof AgentSettingSchema.parse>;
    let warningCount = 0;
    try {
      setting = AgentSettingSchema.parse({
        agentCategory: AgentCategory.Workflow,
        documentTag: 'latex_document',
        endTag: '</latex_document>',
      });
      warningCount = warnSpy.mock.calls.length;
    } finally {
      warnSpy.mockRestore();
    }

    expect(setting.agentCategory).toBe(AgentCategory.Workflow);
    expect(Object.hasOwn(setting, 'documentTag')).toBe(false);
    expect(Object.hasOwn(setting, 'endTag')).toBe(false);
    expect(warningCount).toBe(1);
  });

  it('regression #7497: public remote agent YAML no longer carries documentTag/endTag', () => {
    // The retired keys used to be copy-pasted into every remote agent, so
    // parsing the bundle at startup fired the deprecation console.warn 4-8x
    // on every launch. Assert both the absence of the keys and the silent
    // parse, so a re-added key fails loudly here instead of in users' stderr.
    const dir = resolve(REPO_ROOT, 'prompts/agents/remote');
    const files = readdirSync(dir).filter((name) => name.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let callCountAfterParsing: number;
    try {
      for (const file of files) {
        const raw = yaml.parse(readFileSync(resolve(dir, file), 'utf8'));
        AgentDefinitionSchema.parse(raw);
      }
    } finally {
      // Read the call count before mockRestore(), which clears .mock.calls
      // (it implies mockReset()) — asserting after restore would always pass.
      callCountAfterParsing = warnSpy.mock.calls.length;
      warnSpy.mockRestore();
    }
    expect(callCountAfterParsing).toBe(0);
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

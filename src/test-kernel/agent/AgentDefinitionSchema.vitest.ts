import { describe, expect, it } from 'vitest';

import {
  AgentDefinitionSchema,
  DocumentTaskSchema,
  PersonaSchema,
} from '@agent/core/definition/AgentDataclass';
import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';

describe('AgentDefinitionSchema', () => {
  it('preserves inherited defaults until the post-merge final parse', () => {
    const { name: _parent, ...parent } = AgentDefinitionSchema.parse({
      name: 'parent',
      prompt: 'You are careful.',
      temperature: 0.3,
      task: { rewrite: false, requests: ['Parent request', 'Second'] },
    });
    const {
      name: _child,
      inherits: _inherits,
      ...child
    } = AgentDefinitionSchema.parse({
      name: 'child',
      inherits: 'parent',
      task: { requests: ['Child request'] },
    });

    const { task, ...persona } = mergeInheritedAgentObject(parent, child);

    expect(PersonaSchema.parse(persona)).toMatchObject({
      prompt: 'You are careful.',
      temperature: 0.3,
      tools: [],
    });
    // A task block merges field by field; its request list replaces the
    // parent's.
    expect(DocumentTaskSchema.parse(task)).toMatchObject({
      rewrite: false,
      requests: ['Child request'],
    });
  });
});

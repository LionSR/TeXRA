import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  cleanSessionDescription,
  generateSessionDescription,
  getSessionDescriptionInstruction,
} from '@agent/runtime/sessionDescription';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  createHelperModelKit: vi.fn(),
  emit: vi.fn(),
  getAgent: vi.fn(),
  writeSessionDescription: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
}));

vi.mock('@agent/runtime/helperModel', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/helperModel')>()),
  createHelperModelKit: mocks.createHelperModelKit,
}));

vi.mock('@agent/storage', () => ({
  writeSessionDescription: mocks.writeSessionDescription,
}));

function configFor(category: AgentCategory) {
  return AgentConfigSchema.parse({
    agent: category === AgentCategory.ToolUse ? 'chat' : 'correct',
    model: 'gemini35f',
    instruction: 'Fix grammar.',
    agentCategory: category,
  });
}

describe('session description helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes model-generated descriptions for compact UI labels', () => {
    expect(cleanSessionDescription('"Fixing TikZ arrows."')).toBe(
      'Fixing TikZ arrows',
    );
    expect(cleanSessionDescription('Reviewing\n introduction')).toBe(
      'Reviewing introduction',
    );
  });

  it('prefers displayInstruction over hidden prompt context', () => {
    expect(
      getSessionDescriptionInstruction({
        displayInstruction: 'Assess the proof concisely.',
        instruction:
          'Primary user input files:\n- "problem.md"\n\nAdditional user instruction:\n\nAssess the proof concisely.',
      }),
    ).toBe('Assess the proof concisely.');
  });

  it('falls back to instruction when displayInstruction is blank', () => {
    expect(
      getSessionDescriptionInstruction({
        displayInstruction: '   ',
        instruction: 'Summarize the paper.',
      }),
    ).toBe('Summarize the paper.');
  });

  it('does not generate helper-model descriptions for workflow runs', async () => {
    await generateSessionDescription(
      'exec-workflow' as ExecutionId,
      'stream-workflow' as StreamTabId,
      configFor(AgentCategory.Workflow),
      { emit: mocks.emit } as unknown as AgentRuntimeHost,
    );

    expect(mocks.createHelperModelKit).not.toHaveBeenCalled();
    expect(mocks.writeSessionDescription).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('keeps generating compact descriptions for tool-use runs', async () => {
    const handler = {
      createResponse: vi.fn().mockResolvedValue({ response: {} }),
      extractResponse: vi.fn().mockReturnValue({ text: 'Fixing proof typos' }),
      initializeMessages: vi.fn().mockResolvedValue([]),
    };
    mocks.getAgent.mockReturnValue({ description: 'General chat assistant' });
    mocks.createHelperModelKit.mockResolvedValue({
      kit: { client: {}, handler },
    });

    await generateSessionDescription(
      'exec-tool' as ExecutionId,
      'stream-tool' as StreamTabId,
      configFor(AgentCategory.ToolUse),
      { emit: mocks.emit } as unknown as AgentRuntimeHost,
    );

    expect(mocks.writeSessionDescription).toHaveBeenCalledWith(
      'exec-tool',
      'Fixing proof typos',
    );
    expect(mocks.emit).toHaveBeenCalledWith('updateStreamDescription', {
      streamId: 'stream-tool',
      description: 'Fixing proof typos',
    });
  });
});

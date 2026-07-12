// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  generateSessionDescription,
  getSessionDescriptionInstruction,
} from '@agent/runtime/sessionDescription';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionEvent } from '@agent/runtime/SessionEventHub';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  createHelperModelKit: vi.fn(),
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
    const session = createTestSession();
    const events: SessionEvent[] = [];
    const detach = session.events.subscribe((event) => events.push(event), {
      scope: 'session',
    });

    await generateSessionDescription(
      'exec-workflow' as ExecutionId,
      'stream-workflow' as StreamTabId,
      configFor(AgentCategory.Workflow),
      session,
    );
    detach();

    expect(mocks.createHelperModelKit).not.toHaveBeenCalled();
    expect(mocks.writeSessionDescription).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('keeps generating compact descriptions for tool-use runs', async () => {
    const session = createTestSession();
    const events: SessionEvent[] = [];
    const detach = session.events.subscribe((event) => events.push(event), {
      scope: 'session',
    });
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
      session,
    );
    detach();

    expect(mocks.writeSessionDescription).toHaveBeenCalledWith(
      'exec-tool',
      'Fixing proof typos',
    );
    expect(events).toEqual([
      {
        scope: 'session',
        event: {
          type: 'updateStreamDescription',
          payload: {
            streamId: 'stream-tool',
            description: 'Fixing proof typos',
          },
        },
      },
    ]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  cleanSessionDescription,
  generateSessionDescription,
  getSessionDescriptionInstruction,
} from '@agent/runtime/sessionDescription';
import type { SessionEvent } from '@agent/runtime/SessionEventHub';
import * as logger from '@logger/logUtils';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';

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
    vi.restoreAllMocks();
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

  it('logs helper-model failures without rejecting the fire-and-forget call', async () => {
    const session = createTestSession();
    const helperError = new Error('helper unavailable');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mocks.getAgent.mockReturnValue({ description: 'General chat assistant' });
    mocks.createHelperModelKit.mockRejectedValueOnce(helperError);

    await expect(
      generateSessionDescription(
        'exec-failure' as ExecutionId,
        'stream-failure' as StreamTabId,
        configFor(AgentCategory.ToolUse),
        session,
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'SessionDescription',
      expect.stringContaining('helper unavailable'),
    );
  });

  it('does not reject when the diagnostic sink also fails', async () => {
    const session = createTestSession();
    mocks.getAgent.mockReturnValue({ description: 'General chat assistant' });
    mocks.createHelperModelKit.mockRejectedValueOnce(
      new Error('helper unavailable'),
    );
    vi.spyOn(logger, 'warn').mockImplementation(() => {
      throw new Error('log sink unavailable');
    });

    await expect(
      generateSessionDescription(
        'exec-log-failure' as ExecutionId,
        'stream-log-failure' as StreamTabId,
        configFor(AgentCategory.ToolUse),
        session,
      ),
    ).resolves.toBeUndefined();
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

describe('cleanSessionDescription', () => {
  it.each<[name: string, input: string, expected: string]>([
    [
      'returns short text unchanged',
      'Reviewing introduction for clarity',
      'Reviewing introduction for clarity',
    ],
    [
      'collapses newlines into single spaces',
      'Reviewing\nintroduction\n  for clarity',
      'Reviewing introduction for clarity',
    ],
    [
      'strips surrounding double quotes',
      '"Fixing TikZ arrows"',
      'Fixing TikZ arrows',
    ],
    [
      'strips surrounding backticks',
      '`Fixing TikZ arrows`',
      'Fixing TikZ arrows',
    ],
    [
      'strips surrounding single quotes',
      "'Fixing TikZ arrows'",
      'Fixing TikZ arrows',
    ],
    ['strips a trailing period', 'Fixing arrows.', 'Fixing arrows'],
    [
      'strips trailing bang and question marks',
      'Fixing arrows!?',
      'Fixing arrows',
    ],
    ['strips a trailing ellipsis', 'Fixing arrows…', 'Fixing arrows'],
    ['empties quote-only input', '"..."', ''],
    ['empties backtick-only input', '``', ''],
    ['empties whitespace-only input', '   ', ''],
    [
      'rejects full-sentence helper responses instead of persisting stale prose',
      'Since the system environment for this run does not provide delegation tools, I cannot delegate.',
      '',
    ],
    [
      'keeps compact labels within the description word budget',
      'Checking concise proof with one delegated review subagent',
      'Checking concise proof with one delegated review subagent',
    ],
  ])('%s', (_name, input, expected) => {
    expect(cleanSessionDescription(input)).toBe(expected);
  });

  it('truncates with ellipsis at 80 characters', () => {
    const result = cleanSessionDescription('a'.repeat(120));
    expect(result).toHaveLength(80);
    expect(result.endsWith('…')).toBe(true);
  });
});

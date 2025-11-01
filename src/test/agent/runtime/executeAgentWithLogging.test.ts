// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { parseAgentConfig, type AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentType,
  AgentCategory,
  type AgentSessionDescriptor,
} from '@agent/core/AgentDataclass';
import type { AgentRunHooks, IAgent } from '@agent/core/IAgent';
import type { AgentRunContext } from '@agent/runtime/AgentRunContext';
import { executeAgentWithLogging } from '@agent/runtime/executeAgent';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - progress view
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

// Local imports - logging
import { getStreamTabId as buildStreamTabId } from '@logger/streamUtils';

class StubAgent implements IAgent {
  public config: AgentConfig;
  public appliedContext?: AgentRunContext;
  public initCalled = false;
  public runCalled = false;

  constructor(config: AgentConfig, session: AgentSessionDescriptor) {
    this.config = { ...config, session };
  }

  applyRunContext(context: AgentRunContext): void {
    this.appliedContext = context;
  }

  async init(): Promise<void> {
    this.initCalled = true;
  }

  async run(): Promise<void> {
    if (!this.appliedContext) {
      throw new Error('run invoked without applied context');
    }
    this.runCalled = true;
  }

  interrupt(): void {
    /* noop */
  }

  getStreamTabId(): StreamTabId {
    if (!this.appliedContext) {
      throw new Error('stream requested without context');
    }
    return this.appliedContext.streamTabId;
  }

  getSessionMetadata(): AgentSessionDescriptor {
    if (!this.config.session) {
      throw new Error('missing session metadata');
    }
    return this.config.session;
  }

  getLastRunGroupId(): string | undefined {
    return undefined;
  }

  getRunHooks(): AgentRunHooks {
    return {
      start: async () => undefined,
      init: async () => {},
      initializeClient: async () => {},
      end: () => {},
      cleanup: () => {},
    };
  }
}

describe('executeAgentWithLogging', () => {
  const originalGetInstance = ProgressViewProvider.getInstance;
  const originalExecuteCommand = vscode.commands.executeCommand;
  const originalShowInformation = vscode.window.showInformationMessage;
  const originalShowError = vscode.window.showErrorMessage;

  afterEach(() => {
    (
      ProgressViewProvider as typeof ProgressViewProvider & {
        getInstance: typeof ProgressViewProvider.getInstance;
      }
    ).getInstance = originalGetInstance;
    (
      vscode.commands as typeof vscode.commands & {
        executeCommand: typeof vscode.commands.executeCommand;
      }
    ).executeCommand = originalExecuteCommand;
    (
      vscode.window as typeof vscode.window & {
        showInformationMessage: typeof vscode.window.showInformationMessage;
      }
    ).showInformationMessage = originalShowInformation;
    (
      vscode.window as typeof vscode.window & {
        showErrorMessage: typeof vscode.window.showErrorMessage;
      }
    ).showErrorMessage = originalShowError;
  });

  it('applies a shared run context before running the agent', async () => {
    const config = parseAgentConfig({
      agent: 'stub-agent',
      model: 'stub-model',
      instruction: 'demo',
      inputFile: 'input.tex',
    });

    const session: AgentSessionDescriptor = {
      agentType: AgentType.Direct,
      agentCategory: AgentCategory.Workflow,
    };

    const agent = new StubAgent(config, session);
    const statuses: Record<string, string | undefined> = {};

    (
      ProgressViewProvider as typeof ProgressViewProvider & {
        getInstance: typeof ProgressViewProvider.getInstance;
      }
    ).getInstance = () =>
      ({
        isViewVisible: () => true,
        eventHandler: {
          getStreamStatus: (stream: string) => statuses[stream],
          setStreamStatus: (stream: string, status: string) => {
            statuses[stream] = status;
          },
        },
      }) as unknown as ProgressViewProvider;

    (
      vscode.commands as typeof vscode.commands & {
        executeCommand: typeof vscode.commands.executeCommand;
      }
    ).executeCommand = () => Promise.resolve(undefined) as any;

    (
      vscode.window as typeof vscode.window & {
        showInformationMessage: typeof vscode.window.showInformationMessage;
      }
    ).showInformationMessage = () => Promise.resolve(undefined) as any;

    (
      vscode.window as typeof vscode.window & {
        showErrorMessage: typeof vscode.window.showErrorMessage;
      }
    ).showErrorMessage = () => Promise.resolve(undefined) as any;

    await executeAgentWithLogging('stub-agent', async () => ({
      agent,
      agentType: AgentType.Direct,
    }));

    assert.ok(agent.appliedContext, 'expected run context to be applied');
    const context = agent.appliedContext!;

    const expectedStreamId = buildStreamTabId(
      config.agent,
      config.model,
      config.inputFile,
      {
        agentType: session.agentType,
        executionId: undefined,
        useMultipleOutputs: config.useMultipleOutputs,
      },
    );

    assert.strictEqual(context.streamTabId, expectedStreamId);
    assert.strictEqual(context.logger.channelId, expectedStreamId);
    assert.deepStrictEqual(context.session, session);
    assert.ok(agent.initCalled, 'expected init to run');
    assert.ok(agent.runCalled, 'expected run to execute');
    assert.strictEqual(statuses[expectedStreamId], 'stopped');
  });
});

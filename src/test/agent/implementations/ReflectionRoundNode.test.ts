// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent components
import {
  ReflectionRoundNode,
  type ReflectionRoundNodeDeps,
  type RoundLifecycleSharedContext,
  type RoundOutputOptions,
} from '@agent/implementations/BaseReflectionAgent';
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '@agent/core/AgentState';
import { ToolState } from '@agent/core/ToolState';
import type { ResponseCycleOptions } from '@agent/core/ResponseCycle';
import type { IModelHandler } from '@agent/modelHandlers';
import type { AgentLogger } from '@logger/AgentLogger';

suite('ReflectionRoundNode', () => {
  test('executes full lifecycle when generation continues', async () => {
    const agentConfig = AgentConfigSchema.parse({ inputFile: 'input.tex' });
    const agentSetting = AgentSettingSchema.parse({});
    const agentPrompt = AgentPromptSchema.parse({});

    const shared: RoundLifecycleSharedContext = {
      currRound: 0,
      stateRound: new AgentStateRound(0),
      stateGlobal: new AgentStateGlobal(),
      toolState: new ToolState(),
      messages: [],
      prefill: 'prefill text',
      outputPath: 'output.txt',
      roundGroupId: 'group',
    };

    const updatedMessages = [{ role: 'user', content: 'hello' }];
    let initializeCalls = 0;
    const stubModelHandler = {
      initializeOutputAndPrefill: async (
        _agentConfig: unknown,
        _agentSetting: unknown,
        messages: any[],
        _toolState: unknown,
        outputFile: string,
        prefill: string,
        groupId?: string,
      ) => {
        initializeCalls++;
        assert.strictEqual(outputFile, shared.outputPath);
        assert.strictEqual(prefill, shared.prefill);
        assert.strictEqual(groupId, shared.roundGroupId);
        assert.strictEqual(messages, shared.messages);
        return [false, updatedMessages] as const;
      },
    } as unknown as IModelHandler<any, any, any, any, unknown>;

    let runCycleCalls = 0;
    const stubRunResponseCycle = async (
      options: ResponseCycleOptions<unknown>,
      messages: any[],
      stateRound: AgentStateRound,
      stateGlobal: AgentStateGlobal,
      toolState: ToolState,
    ): Promise<[AgentStateRound, AgentStateGlobal, ToolState, boolean]> => {
      runCycleCalls++;
      assert.strictEqual(options.agentConfig, agentConfig);
      assert.strictEqual(options.agentSetting, agentSetting);
      assert.strictEqual(options.agentPrompt, agentPrompt);
      assert.strictEqual(options.logger, stubLogger);
      assert.strictEqual(options.client, clientInstance);
      assert.strictEqual(messages, updatedMessages);
      assert.strictEqual(stateRound, shared.stateRound);
      assert.strictEqual(stateGlobal, shared.stateGlobal);
      assert.strictEqual(toolState, shared.toolState);
      return [stateRound, stateGlobal, toolState, true];
    };

    const completions: RoundOutputOptions[] = [];
    const stubHandleCompletion = async (
      currRound: number,
      stateRound: AgentStateRound,
      stateGlobal: AgentStateGlobal,
      options: RoundOutputOptions,
    ) => {
      assert.strictEqual(currRound, shared.currRound);
      assert.strictEqual(stateRound, shared.stateRound);
      assert.strictEqual(stateGlobal, shared.stateGlobal);
      completions.push(options);
    };

    const debugMessages: string[] = [];
    const stubLogger = {
      debug(message: string) {
        debugMessages.push(message);
      },
    } as unknown as AgentLogger;

    const clientInstance = {};
    const deps: ReflectionRoundNodeDeps<unknown> = {
      agentConfig,
      agentSetting,
      agentPrompt,
      modelHandler: stubModelHandler,
      logger: stubLogger,
      userVars: {},
      getClient: () => clientInstance,
      checkInterruption: () => false,
      setAbortController: () => {},
      runResponseCycle: stubRunResponseCycle,
      handleRoundCompletion: stubHandleCompletion,
    };

    const node = new ReflectionRoundNode(deps);
    await node.run(shared);

    assert.strictEqual(initializeCalls, 1);
    assert.strictEqual(runCycleCalls, 1);
    assert.strictEqual(completions.length, 1);
    assert.strictEqual(completions[0].outputFile, shared.outputPath);
    assert.strictEqual(completions[0].endTurn, true);
    assert.ok(shared.result);
    assert.strictEqual(shared.messages, updatedMessages);
    assert.strictEqual(shared.result?.messages, updatedMessages);
    assert.strictEqual(shared.result?.endTurn, true);
    assert.strictEqual(debugMessages.length, 1);
    assert.ok(debugMessages[0].includes('stateGlobal'));
  });

  test('skips response cycle when initialization ends the turn', async () => {
    const agentConfig = AgentConfigSchema.parse({ inputFile: 'input.tex' });
    const agentSetting = AgentSettingSchema.parse({});
    const agentPrompt = AgentPromptSchema.parse({});

    const shared: RoundLifecycleSharedContext = {
      currRound: 1,
      stateRound: new AgentStateRound(1),
      stateGlobal: new AgentStateGlobal(),
      toolState: new ToolState(),
      messages: [{ role: 'system', content: 'existing' }],
      prefill: 'prefill text',
      outputPath: 'output.txt',
      roundGroupId: 'group',
    };

    let initializeCalls = 0;
    const stubModelHandler = {
      initializeOutputAndPrefill: async () => {
        initializeCalls++;
        return [true, shared.messages] as const;
      },
    } as unknown as IModelHandler<any, any, any, any, unknown>;

    let runCycleCalls = 0;
    const stubRunResponseCycle = async () => {
      runCycleCalls++;
      return [
        shared.stateRound,
        shared.stateGlobal,
        shared.toolState,
        false,
      ] as [AgentStateRound, AgentStateGlobal, ToolState, boolean];
    };

    let completionCallCount = 0;
    const stubHandleCompletion = async (
      currRound: number,
      stateRound: AgentStateRound,
      stateGlobal: AgentStateGlobal,
      options: RoundOutputOptions,
    ) => {
      completionCallCount++;
      assert.strictEqual(currRound, shared.currRound);
      assert.strictEqual(stateRound, shared.stateRound);
      assert.strictEqual(stateGlobal, shared.stateGlobal);
      assert.strictEqual(options.endTurn, true);
    };

    const debugMessages: string[] = [];
    const stubLogger = {
      debug(message: string) {
        debugMessages.push(message);
      },
    } as unknown as AgentLogger;

    const deps: ReflectionRoundNodeDeps<unknown> = {
      agentConfig,
      agentSetting,
      agentPrompt,
      modelHandler: stubModelHandler,
      logger: stubLogger,
      userVars: {},
      getClient: () => ({}),
      checkInterruption: () => false,
      setAbortController: () => {},
      runResponseCycle: stubRunResponseCycle,
      handleRoundCompletion: stubHandleCompletion,
    };

    const node = new ReflectionRoundNode(deps);
    await node.run(shared);

    assert.strictEqual(initializeCalls, 1);
    assert.strictEqual(runCycleCalls, 0);
    assert.strictEqual(completionCallCount, 1);
    assert.ok(shared.result);
    assert.strictEqual(shared.result?.endTurn, true);
    assert.strictEqual(debugMessages.length, 0);
  });
});

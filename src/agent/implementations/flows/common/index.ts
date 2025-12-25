/**
 * Common agent flow infrastructure.
 *
 * Exports:
 * - AgentLifecycle: Phase/status state machine
 * - AgentRunFlowRunner: Flow execution with hooks, AgentRunShared, BaseFlowShared
 * - StandardFinalizeNode: Standard finalize node class
 * - InitExecResult, NodeExecResult: Shared result types for nodes
 *
 * Note: Schemas moved to respective run flow files (ToolUseRunFlow, ReflectionRunFlow)
 * Note: Init nodes are inlined in each flow - no factory needed.
 */

export * from './AgentLifecycle';
export * from './AgentRunFlowRunner';
export * from './createFinalizeNode';
export * from './types';

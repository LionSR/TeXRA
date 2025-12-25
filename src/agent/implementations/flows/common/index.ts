/**
 * Common agent flow infrastructure.
 *
 * Exports:
 * - AgentLifecycle: Phase/status state machine
 * - AgentRunShared: Generic shared state container for all flows
 * - AgentRunFlowOptions: Options for runAgentFlow
 * - runAgentFlow: Flow execution with hooks
 * - InitExecResult, NodeExecResult: Shared result types for nodes
 * - BaseRunStateSchema: Common schema fields for flow state serialization
 * - StandardFinalizeNode, FinalizeContext: Finalize node class and context type
 *
 * Note: Flow-specific schemas extend BaseRunStateSchema in their respective files.
 * Note: Init nodes are inlined in each flow - no factory needed.
 */

export * from './AgentLifecycle';
export * from './AgentRunFlowRunner';
export * from './createFinalizeNode';

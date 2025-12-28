// Agent implementations are now flow-first.
// This module previously exported agent base classes (BaseAgent, BaseReflectionAgent, MergeAgent)
// but all agent execution now runs through flows directly without class instantiation.
//
// For flow implementations, see:
// - @agent/implementations/flows/reflection
// - @agent/implementations/flows/tooluse

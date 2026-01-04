/**
 * Shared logger for progress view managers.
 *
 * All manager classes (TaskGroupManager, StreamTabsManager, UsageStatsManager,
 * OutputFilesManager, RunInstructionManager, WebviewUpdater) share this single
 * logger instance to reduce redundant logger allocations.
 *
 * Module-level instantiation follows the proven pattern from errorHandling.ts.
 */
import { AgentLogger } from '@logger/AgentLogger';

export const ManagerLogger = new AgentLogger('ProgressViewManagers');

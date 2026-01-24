// Local imports - shared schemas
import type {
  LogMessageData,
  OutputFileInfo,
  TaskGroup,
  TokenUsageStats,
  TodoItem,
} from '@shared/schemas';

// Local imports - progress view types
import type { InstructionUpdate } from '@progressView/types';

export interface StreamState {
  logs: LogMessageData[];
  groups: TaskGroup[];
  todos: TodoItem[];
  queuedFollowUps: string[];
  runInstructions: Record<string, InstructionUpdate>;
  activeRunId: string | null;
  outputFilesByRun: Record<string, Record<string, OutputFileInfo[]>>;
  missingOutputsByRun: Record<string, Record<string, string[]>>;
  usageByRun: Record<string, TokenUsageStats>;
  contextState: {
    inputTokens: number;
    contextWindow: number;
    utilizationPercent: number;
  } | null;
  instruction: InstructionUpdate | null;
}

export const createEmptyStreamState = (): StreamState => ({
  logs: [],
  groups: [],
  todos: [],
  queuedFollowUps: [],
  runInstructions: {},
  activeRunId: null,
  outputFilesByRun: {},
  missingOutputsByRun: {},
  usageByRun: {},
  contextState: null,
  instruction: null,
});

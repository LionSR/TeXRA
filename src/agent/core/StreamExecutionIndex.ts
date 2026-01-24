// Local imports - agent identifiers
import type { ExecutionId, StreamTabId } from '@shared/schemas';

interface StreamExecutionEntry<T> {
  streamId: StreamTabId;
  executionId: ExecutionId;
  value: T;
}

export class StreamExecutionIndex<T> {
  private readonly byExecution = new Map<
    ExecutionId,
    StreamExecutionEntry<T>
  >();
  private readonly byStream = new Map<StreamTabId, StreamExecutionEntry<T>>();

  set(streamId: StreamTabId, executionId: ExecutionId, value: T): void {
    const entry: StreamExecutionEntry<T> = { streamId, executionId, value };
    this.byExecution.set(executionId, entry);
    this.byStream.set(streamId, entry);
  }

  deleteByStream(streamId: StreamTabId): StreamExecutionEntry<T> | undefined {
    const entry = this.byStream.get(streamId);
    if (!entry) {
      return undefined;
    }
    this.byStream.delete(streamId);
    this.byExecution.delete(entry.executionId);
    return entry;
  }

  deleteByExecution(
    executionId: ExecutionId,
  ): StreamExecutionEntry<T> | undefined {
    const entry = this.byExecution.get(executionId);
    if (!entry) {
      return undefined;
    }
    this.byExecution.delete(executionId);
    this.byStream.delete(entry.streamId);
    return entry;
  }

  getByStream(streamId: StreamTabId): T | undefined {
    return this.byStream.get(streamId)?.value;
  }

  getByExecution(executionId: ExecutionId): T | undefined {
    return this.byExecution.get(executionId)?.value;
  }

  clear(): void {
    this.byExecution.clear();
    this.byStream.clear();
  }
}

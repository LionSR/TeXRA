import { strict as assert } from 'assert';

import {
  BaseNode,
  BatchNode,
  Flow,
  ParallelBatchNode,
  STOP_ACTION,
} from '@agent/node';

describe('Node abstraction helpers', () => {
  it('runs prep, exec, and post in order', async () => {
    const shared = { log: [] as string[] };

    class LifecycleNode extends BaseNode<
      typeof shared,
      Record<string, never>,
      string,
      string
    > {
      protected override async prep(context: typeof shared): Promise<string> {
        context.log.push('prep');
        return 'prep';
      }

      protected override async exec(prepRes: string): Promise<string> {
        shared.log.push(`exec:${prepRes}`);
        return 'exec';
      }

      protected override async post(
        context: typeof shared,
        prepRes: string,
        execRes: string,
      ): Promise<string> {
        context.log.push(`post:${prepRes}-${execRes}`);
        return 'continue';
      }
    }

    class EndNode extends BaseNode<typeof shared, Record<string, never>> {
      protected override async post(context: typeof shared): Promise<string> {
        context.log.push('end');
        return STOP_ACTION;
      }
    }

    const start = new LifecycleNode();
    const end = new EndNode();
    start.on('continue', end);

    const flow = new Flow<typeof shared>(start);
    await flow.run(shared);

    assert.deepEqual(shared.log, [
      'prep',
      'exec:prep',
      'post:prep-exec',
      'end',
    ]);
  });

  it('loops until stop action is returned', async () => {
    const shared = { count: 0 };

    class LoopNode extends BaseNode<
      typeof shared,
      Record<string, never>,
      number,
      number
    > {
      protected override async prep(context: typeof shared): Promise<number> {
        return context.count;
      }

      protected override async exec(prepRes: number): Promise<number> {
        return prepRes + 1;
      }

      protected override async post(
        context: typeof shared,
        _prepRes: number,
        execRes: number,
      ): Promise<string> {
        context.count = execRes;
        return execRes >= 3 ? STOP_ACTION : 'continue';
      }
    }

    const node = new LoopNode();
    node.on('continue', node);

    const flow = new Flow<typeof shared>(node);
    await flow.run(shared);

    assert.equal(shared.count, 3);
  });

  it('executes batch items sequentially', async () => {
    interface BatchShared {
      items: number[];
      results: number[];
    }

    const shared: BatchShared = { items: [1, 2, 3], results: [] };

    class DoubleBatchNode extends BatchNode<
      BatchShared,
      Record<string, never>,
      number,
      number
    > {
      protected override async prep(context: BatchShared): Promise<number[]> {
        return context.items;
      }

      protected override async runItem(item: number): Promise<number> {
        return item * 2;
      }

      protected override async post(
        context: BatchShared,
        _prepRes: number[],
        execRes: number[],
      ): Promise<string> {
        context.results = execRes;
        return STOP_ACTION;
      }
    }

    const node = new DoubleBatchNode();
    await node.run(shared);

    assert.deepEqual(shared.results, [2, 4, 6]);
  });

  it('runs batch items in parallel when requested', async () => {
    interface ParallelShared {
      items: number[];
      completionOrder: number[];
      results: number[];
    }

    const shared: ParallelShared = {
      items: [1, 2, 3],
      completionOrder: [],
      results: [],
    };

    class ParallelCollectorNode extends ParallelBatchNode<
      ParallelShared,
      Record<string, never>,
      number,
      number
    > {
      protected override async prep(
        context: ParallelShared,
      ): Promise<number[]> {
        return context.items;
      }

      protected override async runItem(item: number): Promise<number> {
        await new Promise((resolve) => setTimeout(resolve, 5 - item));
        shared.completionOrder.push(item);
        return item;
      }

      protected override async post(
        context: ParallelShared,
        _prepRes: number[],
        execRes: number[],
      ): Promise<string> {
        context.results = execRes;
        return STOP_ACTION;
      }
    }

    const node = new ParallelCollectorNode();
    await node.run(shared);

    assert.deepEqual(shared.results, [1, 2, 3]);
    assert.deepEqual(
      shared.completionOrder.sort((a, b) => a - b),
      [1, 2, 3],
    );
  });
});

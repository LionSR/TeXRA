// Standard library imports
import { strict as assert } from 'assert';

// Local imports - node helpers
import { BatchNode, Flow, Node } from '@agent/node';

suite('Node lifecycle', () => {
  test('runs prep, exec, and post in order', async () => {
    const log: string[] = [];

    class LifecycleNode extends Node<Record<string, never>> {
      protected override async prep(): Promise<string> {
        log.push('prep');
        return 'prepared';
      }

      protected override async exec(prepRes: string): Promise<string> {
        log.push(`exec:${prepRes}`);
        return `${prepRes}:executed`;
      }

      protected override async post(
        _shared: Record<string, never>,
        prepRes: string,
        execRes: string,
      ): Promise<string> {
        log.push(`post:${prepRes}->${execRes}`);
        return 'done';
      }
    }

    const node = new LifecycleNode();
    const action = await node.run({});

    assert.strictEqual(action, 'done');
    assert.deepStrictEqual(log, [
      'prep',
      'exec:prepared',
      'post:prepared->prepared:executed',
    ]);
  });

  test('flows advance based on returned actions', async () => {
    interface SharedState {
      iterations: number;
      stages: string[];
    }

    class CountingNode extends Node<SharedState> {
      protected override async post(
        shared: SharedState,
      ): Promise<string | undefined> {
        shared.iterations += 1;
        shared.stages.push(`count:${shared.iterations}`);
        return shared.iterations >= 2 ? undefined : 'next';
      }
    }

    class MarkerNode extends Node<SharedState> {
      protected override async post(
        shared: SharedState,
      ): Promise<string | undefined> {
        shared.stages.push('marker');
        return 'count';
      }
    }

    const start = new CountingNode();
    const marker = new MarkerNode();

    start.on('next', marker);
    marker.on('count', start);

    const flow = new Flow<SharedState>(start);
    const shared: SharedState = { iterations: 0, stages: [] };

    await flow.run(shared);

    assert.deepStrictEqual(shared.stages, ['count:1', 'marker', 'count:2']);
  });

  test('batch nodes aggregate results from exec', async () => {
    interface BatchShared {
      values: number[];
      results: number[];
    }

    class DoubleBatchNode extends BatchNode<BatchShared> {
      protected override async prep(shared: BatchShared): Promise<number[]> {
        return shared.values;
      }

      protected override async exec(value: number): Promise<number> {
        return value * 2;
      }

      protected override async post(
        shared: BatchShared,
        _prepRes: number[],
        execRes: unknown,
      ): Promise<string | undefined> {
        shared.results = execRes as number[];
        return undefined;
      }
    }

    const node = new DoubleBatchNode();
    const shared: BatchShared = { values: [1, 2, 3], results: [] };

    await node.run(shared);

    assert.deepStrictEqual(shared.results, [2, 4, 6]);
  });
});

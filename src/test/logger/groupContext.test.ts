// Standard library imports
import { strict as assert } from 'assert';

// Local imports - logger
import { AgentLogger } from '@logger/AgentLogger';
import { bus } from '@eventBus/ProgressEventBus';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AgentLogger async group context', () => {
  it('associates log entries with the current withGroup scope', async () => {
    const logger = new AgentLogger('TestAsyncGroupPrimary');
    const captured = new Map<string, string | undefined>();
    const off = bus.on('addLogMessage', (payload) => {
      if (payload.stream === 'TestAsyncGroupPrimary') {
        captured.set(payload.logMessage.text, payload.logMessage.groupId);
      }
    });

    await logger.withGroup('Primary', async (groupId) => {
      assert.ok(groupId, 'expected group identifier to be defined');
      logger.info('parent-entry');
      await delay(1);
      logger.info('parent-complete');
    });

    off();

    assert.strictEqual(
      captured.get('parent-entry'),
      captured.get('parent-complete'),
    );
    assert.ok(
      captured.get('parent-entry'),
      'parent logs should be associated with a group',
    );
  });

  it('isolates concurrent nested groups without manual group IDs', async () => {
    const logger = new AgentLogger('TestAsyncGroupConcurrent');
    const logs: { text: string; groupId?: string }[] = [];
    const off = bus.on('addLogMessage', (payload) => {
      if (payload.stream === 'TestAsyncGroupConcurrent') {
        logs.push({
          text: payload.logMessage.text,
          groupId: payload.logMessage.groupId,
        });
      }
    });

    await logger.withGroup('Root', async () => {
      logger.info('root-start');
      await Promise.all([
        logger.withGroup('ChildA', async () => {
          logger.info('child-a-start');
          await delay(2);
          logger.info('child-a-end');
        }),
        logger.withGroup('ChildB', async () => {
          logger.info('child-b-start');
          await delay(1);
          logger.info('child-b-end');
        }),
      ]);
      logger.info('root-end');
    });

    off();

    const groupFor = (label: string): Set<string | undefined> => {
      return new Set(
        logs
          .filter((entry) => entry.text === label)
          .map((entry) => entry.groupId),
      );
    };

    const parentGroups = new Set(
      logs
        .filter((entry) => entry.text.startsWith('root-'))
        .map((entry) => entry.groupId),
    );
    const childAGroups = new Set(
      logs
        .filter((entry) => entry.text.startsWith('child-a'))
        .map((entry) => entry.groupId),
    );
    const childBGroups = new Set(
      logs
        .filter((entry) => entry.text.startsWith('child-b'))
        .map((entry) => entry.groupId),
    );

    assert.strictEqual(parentGroups.size, 1, 'root logs should share a group');
    assert.strictEqual(
      childAGroups.size,
      1,
      'child A logs should share a group',
    );
    assert.strictEqual(
      childBGroups.size,
      1,
      'child B logs should share a group',
    );

    const [parentGroupId] = Array.from(parentGroups);
    const [childAGroupId] = Array.from(childAGroups);
    const [childBGroupId] = Array.from(childBGroups);

    assert.notStrictEqual(parentGroupId, childAGroupId);
    assert.notStrictEqual(parentGroupId, childBGroupId);
    assert.notStrictEqual(childAGroupId, childBGroupId);
    assert.ok(childAGroupId, 'child A logs should have a group');
    assert.ok(childBGroupId, 'child B logs should have a group');

    // Ensure the helper covers repeated log entries with the same label
    const repeatedGroup = groupFor('child-a-end');
    assert.strictEqual(repeatedGroup.size, 1);
  });
});

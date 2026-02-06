// Standard library imports
import { strict as assert } from 'assert';

// Local imports - tools
import {
  executeWolframCode,
  executeWolframScriptFile,
} from '@tools/wolfram/wolframScriptUtils';
import * as toolUtils from '@utils/system/toolUtils';
import * as execUtils from '@utils/system/execUtils';

describe('wolframScriptUtils', () => {
  let originalCheckToolInstalled: typeof toolUtils.checkToolInstalled;
  let originalExecuteCommand: typeof execUtils.executeCommand;

  beforeEach(() => {
    originalCheckToolInstalled = toolUtils.checkToolInstalled;
    originalExecuteCommand = execUtils.executeCommand;
  });

  afterEach(() => {
    (toolUtils as any).checkToolInstalled = originalCheckToolInstalled;
    (execUtils as any).executeCommand = originalExecuteCommand;
  });

  it('executeWolframCode delegates to runWolfram with code args', async () => {
    const calls: any[] = [];
    (toolUtils as any).checkToolInstalled = async () => true;
    (execUtils as any).executeCommand = async (
      command: string[],
      opts: any,
    ) => {
      calls.push(command, opts);
      return { success: true, stdout: '2', stderr: '' } as any;
    };

    const result = await executeWolframCode('1+1');

    assert.deepStrictEqual(calls[0], ['wolframscript', '-code', '1+1']);
    assert.strictEqual(calls[1].timeout, 60000);
    assert.ok(result.success);
    assert.strictEqual(result.output, '2');
  });

  it('executeWolframScriptFile delegates to runWolfram with file args', async () => {
    const calls: any[] = [];
    (toolUtils as any).checkToolInstalled = async () => true;
    (execUtils as any).executeCommand = async (
      command: string[],
      opts: any,
    ) => {
      calls.push(command, opts);
      return { success: true, stdout: 'done', stderr: '' } as any;
    };

    const result = await executeWolframScriptFile('/tmp/test.wls');

    assert.deepStrictEqual(calls[0], [
      'wolframscript',
      '-file',
      '/tmp/test.wls',
    ]);
    assert.strictEqual(calls[1].timeout, 120000);
    assert.ok(result.success);
    assert.strictEqual(result.output, 'done');
  });
});

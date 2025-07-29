import { strict as assert } from 'assert';

// Local imports
import { BashTool } from '@tools/bash';
import { WorkspaceFS } from '@utils/files';

const tool = new BashTool();

describe('BashTool persistent session', () => {
  it('maintains directory between calls and restarts', async () => {
    const cwd = WorkspaceFS.getPath();
    if (!cwd) {
      throw new Error('No workspace path');
    }
    await tool.call({ restart: true });
    const out1 = await tool.call({ command: 'pwd' });
    assert.equal(out1.output?.trim(), cwd);

    await tool.call({ command: 'mkdir -p tmp_test_dir && cd tmp_test_dir' });
    const out2 = await tool.call({ command: 'pwd' });
    assert.ok(out2.output?.endsWith('tmp_test_dir'));

    await tool.call({ restart: true });
    const out3 = await tool.call({ command: 'pwd' });
    assert.equal(out3.output?.trim(), cwd);
  });
});

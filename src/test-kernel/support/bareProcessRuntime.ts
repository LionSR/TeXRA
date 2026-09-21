import { Layer, ManagedRuntime } from 'effect';

import { globalDatabaseLayer } from '@controllers/session/Database';
import { inquiryRecordsLayer } from '@controllers/session/inquiryRecords';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import type { ProcessRuntime } from '@platform/processRuntime';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { createFakeWorkspaceRoots } from './FakePlatform';
import { fakeProcessServices } from './setupPlatform';

/**
 * The bare process runtime over the harness's fake host process services,
 * with the real `InquiryRecords` handle on top: the process runtime the
 * settings/desktop agent surfaces run their programs on. `fakeProcessServices`
 * already supplies the HTTP client, the update-check record mock, and the
 * standard library's filesystem/path services, so this builder names only the
 * inquiry-record override the fake host deliberately leaves mocked.
 */
export function bareProcessRuntime(): ProcessRuntime {
  const { globalStorage } = createFakeWorkspaceRoots();
  return ManagedRuntime.make(
    Layer.mergeAll(
      fakeProcessServices(),
      // Last, so this root's real handle wins over the fake host's mocked one.
      inquiryRecordsLayer.pipe(
        Layer.provideMerge(
          globalDatabaseLayer(globalStorage).pipe(
            Layer.provide(ProcessIdentity.layer(processOwnerId(undefined))),
            Layer.orDie,
          ),
        ),
      ),
    ),
  );
}

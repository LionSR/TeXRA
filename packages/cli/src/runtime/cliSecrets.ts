import { emitAppSignal } from '@eventBus/AppSignals';
import { FileSecrets, secretsPath } from '@platform/defaults/fileSecrets';

/** The CLI's handle on the one credential file under `storageRoot`, telling
 *  this process's surfaces about every key it writes. */
export function cliSecrets(storageRoot: string): FileSecrets {
  return new FileSecrets(secretsPath(storageRoot), (key) =>
    emitAppSignal('credentialChanged', { key }),
  );
}

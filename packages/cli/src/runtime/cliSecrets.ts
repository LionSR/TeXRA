import { emitAppSignal } from '@eventBus/AppSignals';
import { FileSecrets, secretsDirectory } from '@platform/defaults/fileSecrets';

/** The CLI's handle on the one credential file under `storageRoot`, telling
 *  this process's surfaces about every key it writes. */
export function cliSecrets(storageRoot: string): FileSecrets {
  return new FileSecrets(secretsDirectory(storageRoot), (key) =>
    emitAppSignal('credentialChanged', { key }),
  );
}

/**
 * The CLI's install of the process Effect runtime (PRD 7.7).
 *
 * Three CLI entries need one, and any of them may be first: `initCliPlatform`,
 * which opens the state and config stores as Effect programs before it wires
 * the platform; `notifyCliUpdate`, which runs before any platform exists and
 * opens the global state store on its own; and `clone`, which never builds a
 * platform at all yet reads and writes its remote's token through
 * `CliSecrets`. `initCliPlatform` installs a runtime for every fresh platform
 * init (the previous one is disposed on that platform's shutdown path); the
 * other two install one only when nothing has yet, so a normal run still ends
 * with exactly the runtime the platform owns.
 *
 * The identity is the Node default `createNodePlatform` wires as
 * `platform().processes`, read before installing: the CLI's default session
 * opens through the synchronous `open`, which a pending identity would turn
 * into an asynchronous layer build.
 */
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';

let installed = false;

export async function installCliProcessRuntime(
  options: { onlyIfMissing?: boolean } = {},
): Promise<void> {
  if (options.onlyIfMissing && installed) return;
  installed = true;
  installProcessRuntime(await nodeProcesses.selfIdentity());
}

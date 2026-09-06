import type { HostRequest } from '@shared/session/hostRequest';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';

export type PanelRequest = RuntimeRequest | HostRequest;

/**
 * Every permission panel answers the user through the shell's two request
 * events, each carrying the arm it names, so one recorder serves all of
 * them: attach it to a mounted panel and assert on the arms it collected,
 * in order.
 */
export function recordPermissionActions(panel: EventTarget): PanelRequest[] {
  const requests: PanelRequest[] = [];
  const record = (event: Event) => {
    requests.push((event as CustomEvent<PanelRequest>).detail);
  };
  panel.addEventListener('runtime-request', record);
  panel.addEventListener('host-request', record);
  return requests;
}

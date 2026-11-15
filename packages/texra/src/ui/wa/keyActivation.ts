/** Whether a keydown activates a button-like control: Enter or Space, the
 *  keys a native button answers. */
export function isActivationKey(event: KeyboardEvent): boolean {
  return event.key === 'Enter' || event.key === ' ';
}

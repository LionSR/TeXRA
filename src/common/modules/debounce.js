/**
 * Creates a debounced function that delays invoking fn until after delay ms
 * have elapsed since the last time the debounced function was invoked.
 *
 * This implementation mirrors the behavior of perfect-debounce for consistency
 * with the Node.js codebase.
 *
 * @template {(...args: any[]) => any} T
 * @param {T} fn - The function to debounce
 * @param {number} delay - The delay in milliseconds
 * @returns {(...args: Parameters<T>) => void}
 */
export function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

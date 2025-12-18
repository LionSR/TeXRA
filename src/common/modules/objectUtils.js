// Object utility functions - shared helpers for object operations

/**
 * Safely check if an object has its own property.
 * Wrapper around Object.prototype.hasOwnProperty.call() for cleaner code.
 * @param {Object} obj - The object to check
 * @param {string} prop - The property name
 * @returns {boolean} True if the object has the property
 */
export function hasOwn(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

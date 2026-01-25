// @ts-nocheck
/**
 * Task group hierarchy level definitions with formatting behaviors.
 * Pure configuration - no dependencies on other formatter modules.
 */

/**
 * Represents different task group hierarchy levels with associated behaviors.
 * The formatTime method requires a formatter to be passed by the caller.
 */
export const TaskGroupLevel = {
  ROOT: {
    name: 'root',
    formatTime: (date, formatter) => formatter.format(date),
    showTitle: false,
    headerOrder: 'time-first', // time → bullet → usage
    cssClass: 'top-level',
  },
  NESTED: {
    name: 'nested',
    formatTime: (date, formatter) => formatter.format(date),
    showTitle: true,
    headerOrder: 'usage-first', // usage → bullet → time
    cssClass: null,
  },
};

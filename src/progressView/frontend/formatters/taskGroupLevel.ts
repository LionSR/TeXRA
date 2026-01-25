/**
 * Task group hierarchy level definitions with formatting behaviors.
 * Pure configuration - no dependencies on other formatter modules.
 */

type TaskGroupHeaderOrder = 'time-first' | 'usage-first';

export type TaskGroupLevelConfig = {
  name: string;
  formatTime: (date: Date, formatter: Intl.DateTimeFormat) => string;
  showTitle: boolean;
  headerOrder: TaskGroupHeaderOrder;
  cssClass: string | null;
};

/**
 * Represents different task group hierarchy levels with associated behaviors.
 * The formatTime method requires a formatter to be passed by the caller.
 */
export const TaskGroupLevel: Record<'ROOT' | 'NESTED', TaskGroupLevelConfig> = {
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

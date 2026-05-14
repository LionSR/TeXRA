/**
 * Command constants for the memory view.
 */
import { COMMON_COMMANDS } from './commonCommands';

// Memory view specific commands
export const MEMORY_VIEW_COMMANDS = {
  ...COMMON_COMMANDS,
  GET_MEMORY_DATA: 'getMemoryData',
  GET_MEMORY_PREVIEW: 'getMemoryPreview',
  UPDATE_MEMORY: 'updateMemory',
  UPDATE_MEMORY_PREVIEW: 'updateMemoryPreview',
  OPEN_MEMORY_FILE: 'openMemoryFile',
  OPEN_MEMORY_FOLDER: 'openMemoryFolder',
  DELETE_MEMORY: 'deleteMemory',
  GET_MEMORY_ENABLED: 'getMemoryEnabled',
  SET_MEMORY_ENABLED: 'setMemoryEnabled',
  UPDATE_MEMORY_ENABLED: 'updateMemoryEnabled',
  PIN_MEMORY: 'pinMemory',
  UNPIN_MEMORY: 'unpinMemory',
} as const;

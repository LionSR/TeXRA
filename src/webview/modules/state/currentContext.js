// Local imports - webview
import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES,
  CHECK_BOXES_TOOL_USE,
  ELEMENT_IDS,
  SESSION_TYPES,
  SESSION_TYPE_INPUT,
  AGENT_SELECT_IDS,
} from '../constants.js';
import { fileList as defaultFileList } from '../uiManagers/FileList.js';
import {
  safeGetElementById,
  safeGetElementValue,
  safeGetElementChecked,
  isSelectLikeElement,
  getSelectOptionElements,
} from '@common/domUtils.js';

// Note: These defaults must match the values in agentRegistry.ts
const DEFAULT_WORKFLOW_AGENT = 'correct';
const DEFAULT_TOOL_USE_AGENT = 'chat';

function getSessionDefaultAgent(sessionType) {
  return sessionType === SESSION_TYPES.TOOL_USE
    ? DEFAULT_TOOL_USE_AGENT
    : DEFAULT_WORKFLOW_AGENT;
}

const DEFAULT_SINGLE_FILE_TYPES = ['input', 'reference', 'auxiliary', 'media'];

function getSessionType() {
  const sessionTypeElement = safeGetElementById(SESSION_TYPE_INPUT);
  if (
    sessionTypeElement instanceof HTMLInputElement &&
    sessionTypeElement.value
  ) {
    return sessionTypeElement.value;
  }
  return SESSION_TYPES.WORKFLOW;
}

function getAgent(sessionType) {
  const selectId =
    AGENT_SELECT_IDS[sessionType] ?? AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW];
  const selectElement = safeGetElementById(selectId);
  if (isSelectLikeElement(selectElement)) {
    if (selectElement.value) {
      return selectElement.value;
    }
    const option = getSelectOptionElements(selectElement).find(
      (item) => item.value,
    );
    if (option?.value) {
      return option.value;
    }
  }
  return getSessionDefaultAgent(sessionType);
}

function collectSingleFileSelections(singleFileTypes) {
  const selections = {};
  singleFileTypes.forEach((type) => {
    const elementId = `${type}File`;
    selections[elementId] = safeGetElementValue(elementId);
  });
  return selections;
}

function collectMultipleFileSelections(singleFiles, fileList, options = {}) {
  const { excludedIds } = options;
  const skippedIds = excludedIds instanceof Set ? excludedIds : undefined;
  const selections = {};
  MULTIPLE_SELECTIONS.forEach((id) => {
    if (skippedIds?.has(id)) {
      return;
    }
    const container = safeGetElementById(`${id}Container`);
    const isActive = container?.style.display !== 'none';
    selections[`${id}Active`] = isActive;

    const filesDiv = safeGetElementById(id);
    const files = isActive && filesDiv ? fileList.getSelected(filesDiv) : [];

    const singleFileKey = id.replace('Files', 'File');
    const singleFileSelection = singleFiles[singleFileKey];
    selections[id] =
      id !== ELEMENT_IDS.OUTPUT_FILES && singleFileSelection
        ? files.filter((file) => file !== singleFileSelection)
        : files;
  });
  return selections;
}

function collectCheckboxValues() {
  const values = {};
  CHECK_BOXES.forEach((id) => {
    values[id] = safeGetElementChecked(id);
  });
  return values;
}

/**
 * Collect the current main view context from the DOM.
 *
 * @param {{
 *   fileList?: import('../uiManagers/FileList.js').FileList,
 *   singleFileTypes?: string[],
 * }} [options]
 */
export function collectCurrentContext(options = {}) {
  const {
    fileList = defaultFileList,
    singleFileTypes = DEFAULT_SINGLE_FILE_TYPES,
  } = options;
  const sessionType = getSessionType();
  const agent = getAgent(sessionType);
  const singleFileSelections = collectSingleFileSelections(singleFileTypes);
  const excludedMultipleIds =
    sessionType === SESSION_TYPES.TOOL_USE
      ? new Set([ELEMENT_IDS.OUTPUT_FILES])
      : undefined;
  const multipleFileSelections = collectMultipleFileSelections(
    singleFileSelections,
    fileList,
    { excludedIds: excludedMultipleIds },
  );
  const checkboxValues = collectCheckboxValues();

  return {
    agent,
    sessionType,
    isToolUseAgent: sessionType === SESSION_TYPES.TOOL_USE,
    singleFileSelections,
    multipleFileSelections,
    checkboxValues,
  };
}

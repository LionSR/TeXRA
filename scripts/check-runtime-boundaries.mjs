#!/usr/bin/env node
/* global console, process */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCAN_ROOTS = [
  'packages/extension/src',
  'packages/desktop/src',
  'packages/cli/src',
  'src/controllers',
];

const CORE_PUBLIC_SURFACE_ROOTS = ['packages/core/src'];

const CLI_SCRIPT_SCAN_ROOTS = ['packages/cli/scripts'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

const FORBIDDEN_IMPORTS = [
  {
    source: '@agent/storage',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/historyCommands from host/controller code',
  },
  {
    source: '@agent/index',
    includeSubpaths: false,
    guidance: 'use host-safe @agent/runtime command modules instead',
  },
  {
    source: '@agent/index/agentDirectoriesRegistry',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/agentDirectories from host/controller code',
  },
  {
    source: '@agent/index/AgentDirectorySync',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/agentDirectories from host/controller code',
  },
  {
    source: '@agent/index/BundledAgentDirectories',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/agentDirectories from host/controller code',
  },
  {
    source: '@agent/index/platformAgentDirectories',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/agentDirectories from host/controller code',
  },
  {
    source: '@agent/index/agentRegistry',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/agentResolution from host/controller code',
  },
  {
    source: '@agent/followUp/ToolUseFollowUp',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/followUpCommands from host/controller code',
  },
  {
    source: '@agent/followUp/ToolUseFollowUpQueueManager',
    includeSubpaths: true,
    guidance: 'release queues through runtime stream/follow-up commands',
  },
  {
    source: '@agent/runtime/queuedFollowUps',
    includeSubpaths: true,
    guidance:
      'publish queued follow-ups through runtime follow-up or stream commands',
  },
  {
    source: '@agent/runtime/toolUseResume',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/resumeCommands from host/controller code',
  },
  {
    source: '@agent/runtime/SessionResumeRetrieval',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/resumeCommands from host/controller code',
  },
  {
    source: '@agent/runtime/ProgressViewBridge',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/progressViewCommands from host/controller code',
  },
  {
    source: '@frontend/agents/optionsLoader',
    includeSubpaths: true,
    guidance:
      'use intention-level option controllers such as ProgressFollowUpController or MainViewStartupControllerFactory',
  },
  {
    source: '@agent/runtime/helperModelName',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/executionRequests for merge/default-model runtime requests',
  },
  {
    source: '@agent/runtime/agentLoad',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/agentResolution for host/controller agent definition inspection',
  },
  {
    source: '@agent/runtime/polishModel',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/textPolishCommands from host/controller code',
  },
  {
    source: '@agent/runtime/streamTab',
    includeSubpaths: true,
    guidance:
      'use runtime launch/resume commands instead of deriving stream ids in host/controller code',
  },
  {
    source: '@agent/core/execution/executionRequests',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/executionRequests from host/controller code',
  },
  {
    source: '@agent/core/execution/TaskState',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/executionRequests for runtime task-state types and predicates',
  },
  {
    source: '@agent/core/definition/AgentConfig',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/executionRequests for runtime config parsing and task-state construction',
  },
  {
    source: '@agent/core/definition/AgentDataclass',
    includeSubpaths: true,
    guidance:
      'use @shared/schemas/agent for host-visible agent categories or @agent/runtime command modules for runtime agent semantics',
  },
  {
    source: '@agent/utils/agentConfigToTaskState',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/executionRequests for runtime task-state projection',
  },
  {
    source: '@agent/runtime/AgentRuntimeHost',
    includeSubpaths: true,
    guidance: 'use @hosts/AgentRuntimeHost for the host event port',
  },
  {
    source: '@agent/runtime/AgentFlowResult',
    includeSubpaths: true,
    guidance:
      'use host-local structural projections instead of importing runtime flow result internals',
  },
  {
    source: '@agent/runtime/AgentProposalCoordinator',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/runCoordinatorCommands from host/controller code',
  },
  {
    source: '@agent/runtime/PlanApprovalCoordinator',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/runCoordinatorCommands from host/controller code',
  },
  {
    source: '@agent/runtime/RetryRequestCoordinator',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/runCoordinatorCommands from host/controller code',
  },
  {
    source: '@agent/runtime/textEnhancement',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/textPolishCommands from host/controller code',
  },
  {
    source: '@agent/runtime/textConnection',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/textConnectionCommands from host/controller code',
  },
  {
    source: '@agent/runtime/externalInquiryQueries',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/humanInputCommands for external-inquiry runtime queries and decisions',
  },
  {
    source: '@controllers/settingsView/SettingsGoalControllerFactory',
    includeSubpaths: true,
    guidance:
      'construct SettingsGoalController directly; the controller owns its default runtime projection',
  },
  {
    source: '@tools/approval',
    includeSubpaths: false,
    guidance:
      'use @agent/runtime/approvalCommands for approval state; ' +
      'import only specific UI/pure approval helpers when needed',
  },
  {
    source: '@tools/approval/bashApproval',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/approvalCommands for bash approval state',
  },
  {
    source: '@tools/approval/proposalApproval',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/approvalCommands for delegated-task approval state',
  },
  {
    source: '@tools/approval/toolEditApproval',
    includeSubpaths: true,
    guidance:
      'use @agent/runtime/approvalCommands for approval state, or @shared/approval/toolEditDiff for pure diff math',
  },
  {
    source: '@tools/approval/toolEditDiff',
    includeSubpaths: true,
    guidance:
      'use @shared/approval/toolEditDiff for host-visible tool-edit diff math',
  },
  {
    source: '@tools/approval/tempFileManager',
    includeSubpaths: true,
    guidance:
      'use @shared/approval/tempFileManager for host-visible approval temp files',
  },
  {
    source: '@tools/goal',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/goalCommands from host/controller code',
  },
  {
    source: '@tools/inquiry',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/humanInputCommands from host/controller code',
  },
  {
    source: '@tools/userQuestion',
    includeSubpaths: true,
    guidance: 'use @agent/runtime/humanInputCommands from host/controller code',
  },
];

const FORBIDDEN_PATTERNS = [
  {
    pattern: /\bsession\.coordinators\./g,
    label: 'session.coordinators direct access',
    guidance:
      'use @agent/runtime/runCoordinatorCommands from host/controller code',
  },
  {
    pattern: /\bgetAllActiveExecutionIds\(/g,
    label: 'getAllActiveExecutionIds direct access',
    guidance: 'use @agent/runtime/executionQueries from host/controller code',
  },
  {
    pattern: /\bgetRuntimeActiveExecutionIds\(/g,
    label: 'getRuntimeActiveExecutionIds host-side active-id branching',
    guidance:
      'use intention-level runtime commands such as historyCommands deletion requests',
  },
  {
    pattern: /\bgetRuntimeActiveAgentNames\(/g,
    label: 'getRuntimeActiveAgentNames host-side active-agent projection',
    guidance:
      'use intention-level runtime predicates such as hasRuntimeActiveAgentName',
  },
  {
    pattern: /\bhasRuntimeToolUseModelSwitchTarget\(/g,
    label: 'hasRuntimeToolUseModelSwitchTarget split model-switch query',
    guidance: 'use @agent/runtime/modelSwitch getRuntimeModelSwitchState',
  },
  {
    pattern: /\bgetRuntimeModelSwitchDisabledReason\(/g,
    label: 'getRuntimeModelSwitchDisabledReason split model-switch query',
    guidance:
      'use @agent/runtime/modelSwitch getRuntimeModelSwitchState or requestRuntimeModelSwitch',
  },
  {
    pattern: /\bresolveRuntimeAgentCreatorToolGroups\(/g,
    label: 'resolveRuntimeAgentCreatorToolGroups label-key reconstruction',
    guidance:
      'use runtime-projected agent creator options with resolveRuntimeAgentCreatorToolGroupSelection',
  },
  {
    pattern: /\bresolveRuntimeAgentPath\(/g,
    label: 'resolveRuntimeAgentPath deleted agent-resolution forwarding alias',
    guidance:
      'use intention-level agent-resolution commands such as inspectRuntimeAgentDefinition',
  },
  {
    pattern: /\brequestStopStream\(/g,
    label: 'requestStopStream deleted stream-stop convenience alias',
    guidance:
      'use @agent/runtime/streamControl requestRuntimeStreamStop for typed stop outcomes',
  },
  {
    pattern:
      /\b(?:detectRuntimeWaitingStreams|recoverRuntimeRunningStreamsAfterRestart)\(/g,
    label: 'split restart stream recovery command',
    guidance:
      'use @agent/runtime/streamControl recoverRuntimeRunningStreamsFromPersistedState',
  },
  {
    pattern: /\bsetRuntimeStreamStatus\(/g,
    label: 'deleted stream-status forwarding setter',
    guidance:
      'use intention-level stream commands, lifecycle-owned StreamStatusService writes, or createProgressRuntimeStatusPort',
  },
  {
    pattern: /\bclearRuntimeRetryRequest\(/g,
    label: 'clearRuntimeRetryRequest deleted retry cleanup alias',
    guidance:
      'use intention-level stream stop/delete commands instead of clearing retry state directly',
  },
  {
    pattern: /\bgetRuntimeGoalForStream\(/g,
    label: 'getRuntimeGoalForStream raw goal-record projection',
    guidance:
      'use @agent/runtime/goalCommands getRuntimeGoalSessionStatus or getRuntimeGoalControlState',
  },
  {
    pattern: /\blistRuntimeGoals\(/g,
    label: 'listRuntimeGoals raw goal-record list',
    guidance:
      'use @agent/runtime/goalCommands listRuntimeGoalSettingsItems or another intention-level projection',
  },
  {
    pattern: /\bforgetRuntimeGoals?(?:ByExecutionIds)?\(/g,
    label: 'deleted runtime goal cleanup forwarding command',
    guidance:
      'keep goal cleanup inside the owning stream-resource or history command transaction',
  },
  {
    pattern: /\bsetRuntime(?:Bash|ToolEdit)ApprovalSessionBypass\(/g,
    label: 'thin runtime approval bypass setter alias',
    guidance:
      'use @agent/runtime/approvalCommands applyRuntimeApprovalDecisionBypass or coupled approval commands',
  },
  {
    pattern:
      /\bRuntime(?:BundledAgentDirectorySync|PathAgentDirectoryBundleSource)\b/g,
    label: 'runtime agent-directory constructor alias in host/controller code',
    guidance:
      'use @agent/runtime/agentDirectories sync/bootstrap requests with resourcesPath',
  },
  {
    pattern:
      /\bRuntime(?:AgentDirectoryService|GlobalStorageAgentDirectoryStorage)\b/g,
    label:
      'runtime agent-directory service/storage alias in host/controller code',
    guidance:
      'use @agent/runtime/agentDirectories createRuntimeAgentDirectoryProvider',
  },
  {
    pattern: /\b(?:set|get)ProgressViewBridge\(/g,
    label: 'ProgressViewBridge raw getter/setter',
    guidance:
      'use @agent/runtime/progressViewCommands from host/controller code',
  },
  {
    pattern: /\bcreateSettingsGoalController\(/g,
    label: 'deleted settings goal controller factory',
    guidance:
      'construct SettingsGoalController directly; the controller owns its default runtime projection',
  },
  {
    pattern: /\bcreateDesktopMainViewStartupController\(/g,
    label: 'deleted desktop main-view startup controller factory',
    guidance:
      'use createMainViewStartupController from @controllers/mainView/MainViewStartupControllerFactory',
  },
  {
    pattern: /\blet\s+activeHandler:\s*DesktopResumeHandler\b/g,
    label: 'desktop resume last-writer singleton',
    guidance:
      'register desktop resume handlers so multiple desktop windows can retain stream ownership',
  },
  {
    pattern:
      /\b(?:getRuntimeStreamStatusSnapshot|setRuntimeStreamStatusSilently|clearRuntimeStreamStatus|clearAllRuntimeStreamStatuses|markRuntimeRunningStreamsStopped)\b/g,
    label: 'progress runtime-status port assembled outside its owner',
    guidance:
      'use createProgressRuntimeStatusPort from progressRuntimePorts for shared progress backend wiring',
    allowedFiles: new Set([
      'src/controllers/progressView/progressRuntimePorts.ts',
    ]),
  },
  {
    pattern:
      /\b(?:defaultSession\(\)|this\.session|session)\.interrupts\.retainOnly\(new Set\(streams\)\)/g,
    label:
      'progress runtime-session interrupt port assembled outside its owner',
    guidance:
      'use createProgressRuntimeSessionPort from progressRuntimePorts for shared progress backend wiring',
    allowedFiles: new Set([
      'src/controllers/progressView/progressRuntimePorts.ts',
    ]),
  },
  {
    pattern:
      /\b(?:defaultSession\(\)|this\.session|session)\.flushPendingTraces\(\)/g,
    label:
      'progress runtime-session trace-flush port assembled outside its owner',
    guidance:
      'use createProgressRuntimeSessionPort from progressRuntimePorts for shared progress backend wiring',
    allowedFiles: new Set([
      'src/controllers/progressView/progressRuntimePorts.ts',
    ]),
  },
];

const CONTROLLER_FORBIDDEN_IMPORTS = [
  {
    source: 'vscode',
    includeSubpaths: true,
    guidance: 'controllers must stay host-neutral; use a typed host port',
  },
  {
    source: 'electron',
    includeSubpaths: true,
    guidance: 'controllers must stay host-neutral; use a typed host port',
  },
];

const PRIVATE_RUNTIME_IMPORTS = [
  {
    source: './toolUseResume',
    allowedFiles: new Set(),
    guidance:
      'toolUseResume was deleted; keep resume preparation private inside @agent/runtime/resumeCommands',
  },
  {
    source: '@agent/runtime/toolUseResume',
    allowedFiles: new Set(),
    guidance:
      'toolUseResume was deleted; keep resume preparation private inside @agent/runtime/resumeCommands',
  },
];

const DELETED_RUNTIME_EXPORTS = [
  {
    name: 'resolveRuntimeAgentPath',
    guidance: 'agent definition inspection owns launch-context path lookup',
  },
  {
    name: 'resolveRuntimeAgentKey',
    guidance: 'derive selector keys from category-specific runtime lookups',
  },
  {
    name: 'getRuntimeAgentBySourceIdentifier',
    guidance: 'use category-neutral getRuntimeAgent',
  },
  {
    name: 'findRuntimeAgentByIdentifier',
    guidance: 'use resolveRuntimeAgentIdentifiers for batch resolution',
  },
  {
    name: 'listRuntimeAgentsByCategory',
    guidance: 'use listRuntimeAgents({ category })',
  },
  {
    name: 'listRuntimeVisibleAgents',
    guidance: 'use listRuntimeAgents({ category, visibleOnly: true })',
  },
  {
    name: 'getRuntimeToolUseAgentCategory',
    guidance: 'use explicit tool-use lookup or predicate',
  },
  {
    name: 'requestStopStream',
    guidance: 'use requestRuntimeStreamStop for typed stop outcomes',
  },
  {
    name: 'detectRuntimeWaitingStreams',
    guidance:
      'use recoverRuntimeRunningStreamsFromPersistedState for restart recovery',
  },
  {
    name: 'recoverRuntimeRunningStreamsAfterRestart',
    guidance:
      'use recoverRuntimeRunningStreamsFromPersistedState for restart recovery',
  },
  {
    name: 'setRuntimeStreamStatus',
    guidance:
      'use intention-level stream commands, lifecycle-owned StreamStatusService writes, or createProgressRuntimeStatusPort',
  },
  {
    name: 'RuntimeStreamStatusRequest',
    guidance:
      'setRuntimeStreamStatus was deleted as a pure forwarding status setter',
  },
  {
    name: 'releaseQueuedFollowUpsForStreams',
    guidance:
      'release queues through follow-up or stream-resource lifecycle commands',
  },
  {
    name: 'clearRuntimeRetryRequest',
    guidance: 'keep retry cleanup inside stream stop/delete commands',
  },
  {
    name: 'getRuntimeGoalForStream',
    guidance: 'use host-safe goal projections',
  },
  {
    name: 'listRuntimeGoals',
    guidance: 'use listRuntimeGoalSettingsItems or another projection',
  },
  {
    name: 'forgetRuntimeGoal',
    guidance: 'keep goal cleanup inside stream-resource/history transactions',
  },
  {
    name: 'forgetRuntimeGoals',
    guidance: 'keep goal cleanup inside stream-resource/history transactions',
  },
  {
    name: 'forgetRuntimeGoalsByExecutionIds',
    guidance: 'keep goal cleanup inside stream-resource/history transactions',
  },
  {
    name: 'writeRuntimeTerminalStatus',
    guidance:
      'use terminal-event commands such as markRuntimeHistoryExecutionErrored or markRuntimeHistoryExecutionInterrupted',
  },
  {
    name: 'writeRuntimeHistoryResultMeta',
    guidance:
      'use recordRuntimeWorkflowResultArtifacts so historyCommands owns persisted result metadata shape',
  },
  {
    name: 'readRuntimeHistoryTerminalStatus',
    guidance:
      'use resolveRuntimeHistoryTerminalStatus so historyCommands owns persisted-status validation and outcome fallback',
  },
  {
    name: 'getRuntimeActiveExecutionIds',
    guidance: 'fold active-execution guards into intention-level commands',
  },
  {
    name: 'getRuntimeActiveAgentNames',
    guidance:
      'use intention-level predicates such as hasRuntimeActiveAgentName',
  },
  {
    name: 'hasRuntimeToolUseModelSwitchTarget',
    guidance: 'use getRuntimeModelSwitchState',
  },
  {
    name: 'getRuntimeModelSwitchDisabledReason',
    guidance: 'use getRuntimeModelSwitchState or requestRuntimeModelSwitch',
  },
  {
    name: 'setRuntimeBashApprovalSessionBypass',
    guidance: 'route approval decisions through approvalCommands',
  },
  {
    name: 'setRuntimeToolEditApprovalSessionBypass',
    guidance: 'route approval decisions through approvalCommands',
  },
  {
    name: 'RuntimeBundledAgentDirectorySync',
    guidance: 'use runtime bundled-agent sync/bootstrap requests',
  },
  {
    name: 'RuntimePathAgentDirectoryBundleSource',
    guidance: 'use runtime bundled-agent sync/bootstrap requests',
  },
  {
    name: 'RuntimeAgentDirectoryService',
    guidance: 'use createRuntimeAgentDirectoryProvider',
  },
  {
    name: 'RuntimeGlobalStorageAgentDirectoryStorage',
    guidance: 'use createRuntimeAgentDirectoryProvider',
  },
  {
    name: 'isRuntimeLocalAgentSource',
    guidance: 'keep remote-vs-local branching inside directory resolution',
  },
  {
    name: 'ensureAgentCategoryForSource',
    guidance: 'keep source-based category normalization inside agent loading',
  },
  {
    name: 'loadYaml',
    guidance: 'use loadAgentDefinitionInspectionData for inspection data',
  },
  {
    name: 'WorkflowFlowResultSchema',
    guidance: 'keep category schemas private behind AgentFlowResultSchema',
  },
  {
    name: 'ToolUseFlowResultSchema',
    guidance: 'keep category schemas private behind AgentFlowResultSchema',
  },
];

const RUNTIME_FORBIDDEN_PATTERNS = [
  {
    pattern:
      /^\s*(?:const|let|var)\s+persistedWaitingDetections\s*=\s*new Set\b/gm,
    label: 'module-global persisted waiting detection lock',
    guidance:
      'scope persisted follow-up wake/probe reentrancy through SessionHandle follow-up state',
  },
];

const CORE_PUBLIC_SURFACE_FORBIDDEN_IMPORTS = [
  {
    source: '@agent/runtime/AgentRuntimeHost',
    includeSubpaths: true,
    guidance:
      'export the host event port from @hosts/AgentRuntimeHost, not the deleted runtime adapter path',
  },
  {
    source: '@agent/runtime/toolUseResume',
    includeSubpaths: true,
    guidance:
      'toolUseResume was deleted; expose resume behavior through @agent/runtime/resumeCommands if needed',
  },
  {
    source: '@agent/runtime/ProgressViewBridge',
    includeSubpaths: true,
    guidance:
      'ProgressViewBridge was deleted; expose progress visibility through @agent/runtime/progressViewCommands if needed',
  },
  {
    source: '@agent/runtime/textEnhancement',
    includeSubpaths: true,
    guidance:
      'textEnhancement was deleted; expose text polish behavior through @agent/runtime/textPolishCommands if needed',
  },
  {
    source: '@agent/runtime/textConnection',
    includeSubpaths: true,
    guidance:
      'textConnection was deleted; expose diagnostics through @agent/runtime/textConnectionCommands if needed',
  },
];

const CLI_SCRIPT_FORBIDDEN_IMPORTS = [
  {
    source: '@agent/index',
    includeSubpaths: false,
    guidance:
      'CLI scripts should use @agent/runtime/agentResolution for catalogue loading and listing',
  },
  {
    source: '@agent/followUp/ToolUseFollowUpQueueManager',
    includeSubpaths: true,
    guidance:
      'CLI scripts should seed, read, and release follow-up queues through runtime follow-up or stream-lifecycle commands',
  },
  {
    source: '@tools/goal',
    includeSubpaths: true,
    guidance:
      'CLI scripts should use @agent/runtime/goalCommands for host-visible goal state',
  },
  {
    source: '@tools/inquiry',
    includeSubpaths: true,
    guidance:
      'CLI scripts should use shared inquiry projections or @agent/runtime/humanInputCommands, not tool modules',
  },
];

const CORE_PUBLIC_SURFACE_FORBIDDEN_PATTERNS = [
  {
    pattern: /\b(?:WorkflowFlowResultSchema|ToolUseFlowResultSchema)\b/g,
    label: 'core package category result schema',
    guidance:
      'keep @texra/core result validation at the union-level AgentFlowResultSchema',
  },
];

const importSourcePattern =
  /\b(?:import|export)(?:\s+type)?(?:[\s\w*{},]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function deletedRuntimeExportPattern(name) {
  const escaped = name.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&');
  return new RegExp(
    String.raw`\bexport\s+(?:(?:async\s+)?function|const|let|var|class|interface|type|enum)\s+${escaped}\b|\bexport\s*\{[^}]*\b${escaped}\b`,
    'g',
  );
}

function fileExtension(filePath) {
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? '' : filePath.slice(dot);
}

function listSourceFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(fileExtension(entry.name))) {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files;
}

function lineNumberForOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

const violations = [];

function findForbiddenImport(source) {
  for (const forbidden of FORBIDDEN_IMPORTS) {
    if (
      source === forbidden.source ||
      (forbidden.includeSubpaths && source.startsWith(`${forbidden.source}/`))
    ) {
      return forbidden;
    }
  }
  return undefined;
}

function findControllerForbiddenImport(source) {
  for (const forbidden of CONTROLLER_FORBIDDEN_IMPORTS) {
    if (
      source === forbidden.source ||
      (forbidden.includeSubpaths && source.startsWith(`${forbidden.source}/`))
    ) {
      return forbidden;
    }
  }
  return undefined;
}

function findCorePublicSurfaceForbiddenImport(source) {
  for (const forbidden of CORE_PUBLIC_SURFACE_FORBIDDEN_IMPORTS) {
    if (
      source === forbidden.source ||
      (forbidden.includeSubpaths && source.startsWith(`${forbidden.source}/`))
    ) {
      return forbidden;
    }
  }
  return undefined;
}

function findCliScriptForbiddenImport(source) {
  for (const forbidden of CLI_SCRIPT_FORBIDDEN_IMPORTS) {
    if (
      source === forbidden.source ||
      (forbidden.includeSubpaths && source.startsWith(`${forbidden.source}/`))
    ) {
      return forbidden;
    }
  }
  return undefined;
}

for (const root of SCAN_ROOTS) {
  for (const filePath of listSourceFiles(root)) {
    const relativePath = relative(process.cwd(), filePath);
    const text = readFileSync(filePath, 'utf8');
    for (const match of text.matchAll(importSourcePattern)) {
      const source = match[1] ?? match[2];
      const forbidden = findForbiddenImport(source);
      if (forbidden) {
        violations.push({
          filePath: relativePath,
          line: lineNumberForOffset(text, match.index ?? 0),
          source,
          forbiddenSource: forbidden.source,
          guidance: forbidden.guidance,
        });
      }
      if (root === 'src/controllers') {
        const controllerForbidden = findControllerForbiddenImport(source);
        if (controllerForbidden) {
          violations.push({
            filePath: relativePath,
            line: lineNumberForOffset(text, match.index ?? 0),
            source,
            forbiddenSource: controllerForbidden.source,
            guidance: controllerForbidden.guidance,
          });
        }
      }
    }
    for (const forbidden of FORBIDDEN_PATTERNS) {
      for (const match of text.matchAll(forbidden.pattern)) {
        if (forbidden.allowedFiles?.has(relativePath)) continue;
        violations.push({
          filePath: relativePath,
          line: lineNumberForOffset(text, match.index ?? 0),
          source: forbidden.label,
          forbiddenSource: forbidden.label,
          guidance: forbidden.guidance,
        });
      }
    }
  }
}

for (const root of CLI_SCRIPT_SCAN_ROOTS) {
  for (const filePath of listSourceFiles(root)) {
    const relativePath = relative(process.cwd(), filePath);
    const text = readFileSync(filePath, 'utf8');
    for (const match of text.matchAll(importSourcePattern)) {
      const source = match[1] ?? match[2];
      const forbidden = findCliScriptForbiddenImport(source);
      if (!forbidden) continue;
      violations.push({
        filePath: relativePath,
        line: lineNumberForOffset(text, match.index ?? 0),
        source,
        forbiddenSource: forbidden.source,
        guidance: forbidden.guidance,
      });
    }
  }
}

for (const filePath of listSourceFiles('src/agent/runtime')) {
  const relativePath = relative(process.cwd(), filePath);
  const text = readFileSync(filePath, 'utf8');
  for (const match of text.matchAll(importSourcePattern)) {
    const source = match[1] ?? match[2];
    const forbidden = PRIVATE_RUNTIME_IMPORTS.find(
      (candidate) =>
        candidate.source === source &&
        !candidate.allowedFiles.has(relativePath),
    );
    if (!forbidden) continue;
    violations.push({
      filePath: relativePath,
      line: lineNumberForOffset(text, match.index ?? 0),
      source,
      forbiddenSource: forbidden.source,
      guidance: forbidden.guidance,
    });
  }
  for (const deleted of DELETED_RUNTIME_EXPORTS) {
    for (const match of text.matchAll(
      deletedRuntimeExportPattern(deleted.name),
    )) {
      violations.push({
        filePath: relativePath,
        line: lineNumberForOffset(text, match.index ?? 0),
        source: deleted.name,
        forbiddenSource: deleted.name,
        guidance: deleted.guidance,
      });
    }
  }
  for (const forbidden of RUNTIME_FORBIDDEN_PATTERNS) {
    for (const match of text.matchAll(forbidden.pattern)) {
      violations.push({
        filePath: relativePath,
        line: lineNumberForOffset(text, match.index ?? 0),
        source: forbidden.label,
        forbiddenSource: forbidden.label,
        guidance: forbidden.guidance,
      });
    }
  }
}

for (const root of CORE_PUBLIC_SURFACE_ROOTS) {
  for (const filePath of listSourceFiles(root)) {
    const relativePath = relative(process.cwd(), filePath);
    const text = readFileSync(filePath, 'utf8');
    for (const match of text.matchAll(importSourcePattern)) {
      const source = match[1] ?? match[2];
      const forbidden = findCorePublicSurfaceForbiddenImport(source);
      if (!forbidden) continue;
      violations.push({
        filePath: relativePath,
        line: lineNumberForOffset(text, match.index ?? 0),
        source,
        forbiddenSource: forbidden.source,
        guidance: forbidden.guidance,
      });
    }
    for (const forbidden of CORE_PUBLIC_SURFACE_FORBIDDEN_PATTERNS) {
      for (const match of text.matchAll(forbidden.pattern)) {
        violations.push({
          filePath: relativePath,
          line: lineNumberForOffset(text, match.index ?? 0),
          source: forbidden.label,
          forbiddenSource: forbidden.label,
          guidance: forbidden.guidance,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Runtime boundary check failed:\n');
  for (const violation of violations) {
    console.error(
      `- ${violation.filePath}:${violation.line} imports ${violation.source}`,
    );
    if (violation.source !== violation.forbiddenSource) {
      console.error(
        `  matched forbidden boundary ${violation.forbiddenSource}`,
      );
    }
    console.error(`  ${violation.guidance}`);
  }
  process.exit(1);
}

console.log(
  `runtime boundary OK: checked ${SCAN_ROOTS.join(', ')} for ` +
    `${FORBIDDEN_IMPORTS.length} forbidden host/controller imports and ` +
    `${FORBIDDEN_PATTERNS.length} forbidden host/controller patterns, plus ` +
    `${CLI_SCRIPT_FORBIDDEN_IMPORTS.length} CLI-script runtime boundary rules, plus ` +
    `${CONTROLLER_FORBIDDEN_IMPORTS.length} controller host-neutrality rules ` +
    `and ${PRIVATE_RUNTIME_IMPORTS.length} private runtime import rules, plus ` +
    `${DELETED_RUNTIME_EXPORTS.length} deleted runtime export rules, plus ` +
    `${RUNTIME_FORBIDDEN_PATTERNS.length} runtime source pattern rules, plus ` +
    `${CORE_PUBLIC_SURFACE_FORBIDDEN_IMPORTS.length} core public-surface imports ` +
    `and ${CORE_PUBLIC_SURFACE_FORBIDDEN_PATTERNS.length} core public-surface patterns.`,
);

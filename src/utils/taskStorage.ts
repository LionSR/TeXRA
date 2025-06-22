// Standard library imports
import * as path from 'path';
import { randomUUID } from 'crypto';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - storage
import { StorageFS, WorkspaceFS } from '@utils/files';

// Local imports - log
import * as logger from '@logger/logUtils';

const CHANNEL = 'TaskStorage';
logger.initialize(CHANNEL);

export interface TaskInfo {
  taskId: string;
  timestamp: string;
  agent: string;
  model: string;
  inputFile: string;
  outputFiles?: string[];
  status: 'running' | 'completed' | 'error';
}

/**
 * Manages task storage in workspace storage directory
 */
export class TaskStorageManager {
  private static readonly TASKS_DIR = 'tasks';

  /**
   * Generate a new task ID
   */
  public static generateTaskId(): string {
    return randomUUID();
  }

  /**
   * Get the tasks directory path
   */
  public static getTasksDirectory(): string {
    return StorageFS.fullPath(this.TASKS_DIR);
  }

  /**
   * Get the task directory path for a specific task ID
   */
  public static getTaskDirectory(taskId: string): string {
    return StorageFS.fullPath(path.join(this.TASKS_DIR, taskId));
  }

  /**
   * Create a new task directory and return the task info
   */
  public static async createTask(
    agent: string,
    model: string,
    inputFile: string,
    outputFiles?: string[]
  ): Promise<TaskInfo> {
    const taskId = this.generateTaskId();
    const taskDir = this.getTaskDirectory(taskId);
    
    logger.debug(CHANNEL, `Creating task directory: ${taskDir}`);
    
    // Create task directory
    await StorageFS.createDir(taskDir);
    
    // Copy input file to task directory
    const inputFileName = path.basename(inputFile);
    const taskInputPath = path.join(this.TASKS_DIR, taskId, inputFileName);
    
    // Copy from workspace to storage
    const inputContent = await WorkspaceFS.readFile(inputFile);
    await StorageFS.write(taskInputPath, inputContent);
    
    const taskInfo: TaskInfo = {
      taskId,
      timestamp: new Date().toISOString(),
      agent,
      model,
      inputFile,
      outputFiles,
      status: 'running'
    };
    
    // Save task metadata
    await this.saveTaskInfo(taskId, taskInfo);
    
    logger.info(CHANNEL, `Created task ${taskId} for ${agent}@${model}`);
    
    return taskInfo;
  }

  /**
   * Save raw XML output for a specific round
   */
  public static async saveRawXml(
    taskId: string,
    round: number,
    xmlContent: string
  ): Promise<void> {
    const xmlPath = path.join(this.TASKS_DIR, taskId, `raw_r${round}.xml`);
    
    logger.debug(CHANNEL, `Saving raw XML for task ${taskId}, round ${round}`);
    
    await StorageFS.write(xmlPath, xmlContent);
  }

  /**
   * Load raw XML for a specific round
   */
  public static async loadRawXml(
    taskId: string,
    round: number
  ): Promise<string | null> {
    const xmlPath = path.join(this.TASKS_DIR, taskId, `raw_r${round}.xml`);
    
    try {
      if (await StorageFS.exists(xmlPath)) {
        return await StorageFS.read(xmlPath);
      }
      return null;
    } catch (err) {
      logger.error(
        CHANNEL,
        `Failed to load raw XML for task ${taskId}, round ${round}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /**
   * Get the latest round number for a task
   */
  public static async getLatestRound(taskId: string): Promise<number> {
    const taskPath = path.join(this.TASKS_DIR, taskId);
    
    try {
      const entries = await StorageFS.readDir(taskPath);
      const xmlFiles = entries
        .filter(([name, type]) => 
          type === vscode.FileType.File && 
          name.startsWith('raw_r') && 
          name.endsWith('.xml')
        )
        .map(([name]) => name);
      
      if (xmlFiles.length === 0) {
        return -1;
      }
      
      const rounds = xmlFiles.map(f => {
        const match = f.match(/raw_r(\d+)\.xml/);
        return match ? parseInt(match[1]) : -1;
      }).filter(r => r >= 0);
      
      return Math.max(...rounds);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Failed to get latest round for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return -1;
    }
  }

  /**
   * Save task metadata
   */
  public static async saveTaskInfo(taskId: string, taskInfo: TaskInfo): Promise<void> {
    const metadataPath = path.join(this.TASKS_DIR, taskId, 'task_info.json');
    
    await StorageFS.write(metadataPath, JSON.stringify(taskInfo, null, 2));
  }

  /**
   * Load task metadata
   */
  public static async loadTaskInfo(taskId: string): Promise<TaskInfo | null> {
    const metadataPath = path.join(this.TASKS_DIR, taskId, 'task_info.json');
    
    try {
      if (await StorageFS.exists(metadataPath)) {
        const content = await StorageFS.read(metadataPath);
        return JSON.parse(content) as TaskInfo;
      }
      return null;
    } catch (err) {
      logger.error(
        CHANNEL,
        `Failed to load task info for ${taskId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /**
   * Update task status
   */
  public static async updateTaskStatus(
    taskId: string,
    status: TaskInfo['status']
  ): Promise<void> {
    const taskInfo = await this.loadTaskInfo(taskId);
    if (taskInfo) {
      taskInfo.status = status;
      await this.saveTaskInfo(taskId, taskInfo);
    }
  }

  /**
   * Copy workspace files to task directory (for packing)
   */
  public static async copyFilesToTask(
    taskId: string,
    files: string[]
  ): Promise<void> {
    logger.debug(CHANNEL, `Copying ${files.length} files to task ${taskId}`);
    
    for (const file of files) {
      if (await WorkspaceFS.exists(file)) {
        const fileName = path.basename(file);
        const taskFilePath = path.join(this.TASKS_DIR, taskId, fileName);
        
        const content = await WorkspaceFS.readFile(file);
        await StorageFS.write(taskFilePath, content);
        logger.debug(CHANNEL, `Copied ${file} -> ${taskFilePath}`);
      }
    }
  }

  /**
   * Move workspace files to task directory (for packing)
   */
  public static async moveFilesToTask(
    taskId: string,
    files: string[]
  ): Promise<void> {
    logger.debug(CHANNEL, `Moving ${files.length} files to task ${taskId}`);
    
    for (const file of files) {
      if (await WorkspaceFS.exists(file)) {
        const fileName = path.basename(file);
        const taskFilePath = path.join(this.TASKS_DIR, taskId, fileName);
        
        const content = await WorkspaceFS.readFile(file);
        await StorageFS.write(taskFilePath, content);
        await WorkspaceFS.delete(file);
        logger.debug(CHANNEL, `Moved ${file} -> ${taskFilePath}`);
      }
    }
  }

  /**
   * List all tasks
   */
  public static async listTasks(): Promise<TaskInfo[]> {
    try {
      if (!(await StorageFS.exists(this.TASKS_DIR))) {
        return [];
      }
      
      const entries = await StorageFS.readDir(this.TASKS_DIR);
      const taskDirs = entries
        .filter(([, type]) => type === vscode.FileType.Directory)
        .map(([name]) => name);
      
      const tasks: TaskInfo[] = [];
      
      for (const taskId of taskDirs) {
        const taskInfo = await this.loadTaskInfo(taskId);
        if (taskInfo) {
          tasks.push(taskInfo);
        }
      }
      
      // Sort by timestamp, newest first
      return tasks.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    } catch (err) {
      logger.error(
        CHANNEL,
        `Failed to list tasks: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  /**
   * Open task directory in VSCode
   */
  public static async openTaskDirectory(taskId: string): Promise<void> {
    const taskDir = this.getTaskDirectory(taskId);
    
    if (await StorageFS.exists(taskDir)) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(taskDir), true);
    } else {
      vscode.window.showErrorMessage(`Task directory not found: ${taskId}`);
    }
  }

  /**
   * Open raw XML file in VSCode
   */
  public static async openRawXml(taskId: string, round: number): Promise<void> {
    const xmlPath = path.join(this.TASKS_DIR, taskId, `raw_r${round}.xml`);
    const fullXmlPath = StorageFS.fullPath(xmlPath);
    
    if (await StorageFS.exists(xmlPath)) {
      const doc = await vscode.workspace.openTextDocument(fullXmlPath);
      await vscode.window.showTextDocument(doc);
    } else {
      vscode.window.showErrorMessage(`Raw XML file not found: ${fullXmlPath}`);
    }
  }
}
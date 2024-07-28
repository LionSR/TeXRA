import * as vscode from 'vscode';
import * as path from 'path';

function getConfig() {
  return vscode.workspace.getConfiguration('coauthor');
}

export async function listInputFiles(): Promise<string[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const config = getConfig();
    const ignoredExtensions = config.get<string[]>('ignoredFileExtensions') || [];
    const ignoredKeywords = config.get<string[]>('ignoredKeywords') || [];
    const ignoredInputFiles = config.get<string[]>('ignoredInputFiles') || [];
    const ignoredDirectories = config.get<string[]>('ignoredDirectories') || [];
    return await getFilesRecursively(workspacePath, workspacePath, ['.txt', '.tex'], ignoredExtensions, ignoredDirectories, ignoredKeywords, ignoredInputFiles);
  }
  return [];
}

export async function listSampleFiles(): Promise<string[]> {
  return listInputFiles(); // Same logic as listInputFiles
}

export async function listAuxFiles(): Promise<string[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const config = getConfig();
    const ignoredExtensions = config.get<string[]>('ignoredFileExtensions') || [];
    const ignoredKeywords = config.get<string[]>('ignoredKeywords') || [];
    const additionalIgnoredAuxKeywords = config.get<string[]>('additionalIgnoredAuxKeywords') || [];
    const ignoredDirectories = config.get<string[]>('ignoredDirectories') || [];
    
    const combinedIgnoredKeywords = [...new Set([...ignoredKeywords, ...additionalIgnoredAuxKeywords])];
    
    return await getFilesInDirectory(workspacePath, ['.txt', '.tex', '.cls'], ignoredExtensions, ignoredDirectories, combinedIgnoredKeywords);
  }
  return [];
}

export async function listFigureFiles(): Promise<string[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const config = getConfig();
    const includedFigureExtensions = config.get<string[]>('includedFigureExtensions') || ['.png', '.pdf', '.jpeg', '.jpg', '.svg'];
    const ignoredFigureDirectories = config.get<string[]>('ignoredFigureDirectories') || [];
    const ignoredKeywords = config.get<string[]>('ignoredKeywords') || [];
    return await getFilesRecursively(workspacePath, workspacePath, includedFigureExtensions, [], ignoredFigureDirectories, ignoredKeywords);
  }
  return [];
}

export async function listEditedFiles(baseFileName: string): Promise<string[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const config = getConfig();
    const ignoredExtensions = config.get<string[]>('ignoredFileExtensions') || [];
    const ignoredKeywords = config.get<string[]>('ignoredKeywords') || [];
    const ignoredInputFiles = config.get<string[]>('ignoredInputFiles') || [];
    const ignoredDirectories = config.get<string[]>('ignoredDirectories') || [];
    const files = await getFilesRecursively(workspacePath, workspacePath, ['.txt', '.tex'], ignoredExtensions, ignoredDirectories, ignoredKeywords, ignoredInputFiles);
    
    return files.filter(file => {
      const fileBaseName = path.basename(file, path.extname(file));
      return fileBaseName.startsWith(baseFileName) && fileBaseName !== baseFileName;
    });
  }
  return [];
}

export async function getFilesInDirectory(dir: string, includeExtensions: string[] = [], excludeExtensions: string[] = [], excludeDirectories: string[] = [], excludeKeywords: string[] = []): Promise<string[]> {
  const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
  return dirEntries
    .filter(([name, type]) =>
      type === vscode.FileType.File &&
      !name.startsWith('.') &&
      (includeExtensions.length === 0 || includeExtensions.some(ext => name.endsWith(ext))) &&
      !excludeExtensions.some(ext => name.endsWith(ext)) &&
      !excludeKeywords.some(keyword => name.includes(keyword)) &&
      !excludeDirectories.includes(path.dirname(name))
    )
    .map(([name]) => name);
}

export async function getFilesRecursively(dir: string, root: string, includeExtensions: string[] = [], excludeExtensions: string[] = [], excludeDirectories: string[] = [], excludeKeywords: string[] = [], excludeFiles: string[] = []): Promise<string[]> {
  const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
  const files = await Promise.all(dirEntries.map(async ([name, type]) => {
    const fullPath = `${dir}/${name}`;
    const relativePath = fullPath.replace(`${root}/`, '');

    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
    const isSymbolicLink = (stat.type & vscode.FileType.SymbolicLink) === vscode.FileType.SymbolicLink;

    if ((type === vscode.FileType.Directory || isSymbolicLink) && !name.startsWith('.') && !excludeDirectories.includes(name)) {
      return await getFilesRecursively(fullPath, root, includeExtensions, excludeExtensions, excludeDirectories, excludeKeywords, excludeFiles);
    } else if (type === vscode.FileType.File && !name.startsWith('.') &&
      (includeExtensions.length === 0 || includeExtensions.some(ext => name.endsWith(ext))) &&
      !excludeExtensions.some(ext => name.endsWith(ext)) &&
      !excludeKeywords.some(keyword => name.includes(keyword)) &&
      !excludeFiles.includes(name)) {
      return [relativePath];
    } else {
      return [];
    }
  }));
  return files.flat();
}
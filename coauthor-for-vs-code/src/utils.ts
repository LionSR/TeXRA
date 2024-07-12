import * as vscode from 'vscode';
import * as path from 'path';

export async function listInputFiles(): Promise<string[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const workspacePath = workspaceFolders[0].uri.fsPath;
    return await getFilesRecursively(workspacePath, workspacePath, ['.txt', '.tex'], ['.pdf', '.bst', '.bib', '.cls', '.sty', '.json', '.py', '.ipynb', '.png', '.pdf', '.vslx', '.ts', '.js'], ['build', 'node_modules', 'figures', 'Figs', '__pycache__', 'Figures', 'figs', 'Versions'], ['_log_', 'Makefile', 'template', '_log', '_diff', 'command.tex', 'preamble.tex', 'diff', 'draw']);
  }
  return [];
}

export async function listSampleFiles(): Promise<string[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const workspacePath = workspaceFolders[0].uri.fsPath;
    return await getFilesRecursively(workspacePath, workspacePath, ['.txt', '.tex'], ['.pdf', '.bst', '.bib', '.cls', '.sty', '.json', '.py', '.ipynb', '.png', '.pdf', '.vslx', '.ts', '.js'], ['build', 'node_modules', 'figures', 'Figs', '__pycache__', 'Figures', 'figs', 'Versions'], ['_log_', 'Makefile', 'template', '_log', '_diff', 'command.tex', 'preamble.tex', 'diff', 'draw']);
  }
  return [];
}

export async function listAuxFiles(): Promise<string[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const workspacePath = workspaceFolders[0].uri.fsPath;
    return await getFilesInDirectory(workspacePath, ['.txt', '.tex', '.cls'], ['.bst', '.bib', '.pdf', '.sty', '.py', '.json', '.ipynb', '.png', '.pdf', '.vslx', '.ts', '.js'], ['_log_', 'Makefile', 'template', '_log', '_diff', 'draw']);
  }
  return [];
}

export async function listFigureFiles(): Promise<string[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const workspacePath = workspaceFolders[0].uri.fsPath;
    return await getFilesRecursively(workspacePath, workspacePath, ['.png', '.pdf', '.jpeg'], ['.txt', '.tex', '.bst', '.bib', '.cls', '.sty', '.json', '.py', '.ipynb', '.vslx', '.ts', '.js'], ['build', 'node_modules', '__pycache__', "Versions"], ['_log', 'Makefile', 'template', '_diff']);
  }
  return [];
}

export async function listRevisionFiles(inputFileName?: string): Promise<string[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const files = await getFilesRecursively(workspacePath, workspacePath, ['.txt', '.tex'], ['.pdf', '.bst', '.bib', '.cls', '.sty', '.json', '.py', '.ipynb', '.png', '.pdf', '.vslx', '.ts', '.js'], ['build', 'node_modules', 'figures', 'Figs', '__pycache__', 'Figures', 'figs', "Versions"], ['_log_', 'Makefile', 'template', '_log', '_diff', 'command.tex', 'Diffs']);
    if (inputFileName) {
      const inputFileBaseName = path.basename(inputFileName, path.extname(inputFileName));
      return files.filter(file => {
        const fileBaseName = path.basename(file, path.extname(file));
        return fileBaseName.startsWith(inputFileBaseName) && file !== inputFileName;
      });
    }
    return files;
  }
  return [];
}

export async function getFilesInDirectory(dir: string, includeExtensions: string[] = [], excludeExtensions: string[] = [], excludeKeywords: string[] = []): Promise<string[]> {
  const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
  return dirEntries
    .filter(([name, type]) =>
      type === vscode.FileType.File &&
      !name.startsWith('.') &&
      (includeExtensions.length === 0 || includeExtensions.some(ext => name.endsWith(ext))) &&
      !excludeExtensions.some(ext => name.endsWith(ext)) &&
      !excludeKeywords.some(keyword => name.includes(keyword))
    )
    .map(([name]) => name);
}

export async function getFilesRecursively(dir: string, root: string, includeExtensions: string[] = [], excludeExtensions: string[] = [], excludeDirectories: string[] = [], excludeKeywords: string[] = []): Promise<string[]> {
  const dirEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
  const files = await Promise.all(dirEntries.map(async ([name, type]) => {
    const fullPath = `${dir}/${name}`;
    const relativePath = fullPath.replace(`${root}/`, '');

    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
    const isSymbolicLink = (stat.type & vscode.FileType.SymbolicLink) === vscode.FileType.SymbolicLink;

    if ((type === vscode.FileType.Directory || isSymbolicLink) && !name.startsWith('.') && !excludeDirectories.includes(name)) {
      return await getFilesRecursively(fullPath, root, includeExtensions, excludeExtensions, excludeDirectories, excludeKeywords);
    } else if (type === vscode.FileType.File && !name.startsWith('.') &&
      (includeExtensions.length === 0 || includeExtensions.some(ext => name.endsWith(ext))) &&
      !excludeExtensions.some(ext => name.endsWith(ext)) &&
      !excludeKeywords.some(keyword => name.includes(keyword))) {
      return [relativePath];
    } else {
      return [];
    }
  }));
  return files.flat();
}
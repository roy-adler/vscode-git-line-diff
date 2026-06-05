import * as vscode from 'vscode';
import type { ChangedFile, GitApi } from './gitApi';

/** Command invoked when a tree item is selected. */
export const OPEN_DIFF_COMMAND = 'gitlinediff.openDiff';

/** Context value used to gate the inline "open diff" menu contribution. */
const FILE_CONTEXT_VALUE = 'gitLineDiffFile';

/**
 * Tree item representing a single changed file. Selecting it runs the
 * {@link OPEN_DIFF_COMMAND}, passing the underlying {@link ChangedFile} along.
 */
export class ChangedFileItem extends vscode.TreeItem {
  constructor(public readonly file: ChangedFile) {
    super(file.fileName, vscode.TreeItemCollapsibleState.None);
    this.description = file.relativePath;
    this.tooltip = file.uri.fsPath;
    this.resourceUri = file.uri;
    this.contextValue = FILE_CONTEXT_VALUE;
    this.iconPath = vscode.ThemeIcon.File;
    this.command = {
      command: OPEN_DIFF_COMMAND,
      title: 'Open Pretty Diff',
      arguments: [file],
    };
  }
}

/**
 * Predicate deciding whether a changed file should appear in the view.
 * Centralised so additional formats can be enabled by widening the filter.
 */
export type FileFilter = (file: ChangedFile) => boolean;

/** Default filter: only show `*.json` files, per the initial requirements. */
export const jsonOnlyFilter: FileFilter = (file) =>
  file.fileName.toLowerCase().endsWith('.json');

/**
 * Supplies the GitLineDiff Source Control view with the list of changed files
 * that pass the configured {@link FileFilter}. Refreshes automatically when the
 * Git repository state changes.
 */
export class GitLineDiffTreeProvider
  implements vscode.TreeDataProvider<ChangedFileItem>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter =
    new vscode.EventEmitter<ChangedFileItem | undefined | void>();
  public readonly onDidChangeTreeData: vscode.Event<ChangedFileItem | undefined | void> =
    this.onDidChangeTreeDataEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly gitApi: GitApi,
    private readonly filter: FileFilter = jsonOnlyFilter,
  ) {
    // Auto-refresh whenever the repository state changes.
    this.disposables.push(this.gitApi.onDidChange(() => this.refresh()));
  }

  /** Forces the view to re-query the Git API and re-render. */
  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  public getTreeItem(element: ChangedFileItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ChangedFileItem): ChangedFileItem[] {
    // Flat list: only the root produces children.
    if (element !== undefined) {
      return [];
    }
    return this.gitApi
      .getWorkingTreeChanges()
      .filter(this.filter)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((file) => new ChangedFileItem(file));
  }

  public dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

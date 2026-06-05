import * as vscode from 'vscode';
import type { ChangedFile, GitApi } from './gitApi';
import type { FormatterRegistry } from './formatterRegistry';

/** Command invoked when a tree item is selected. */
export const OPEN_DIFF_COMMAND = 'gitlinediff.openDiff';

/** Context value used to gate the inline "open diff" menu contribution. */
const FILE_CONTEXT_VALUE = 'gitLineDiffFile';

/**
 * Tree item representing a single changed file. Selecting it runs the
 * {@link OPEN_DIFF_COMMAND}, passing the underlying {@link ChangedFile} along.
 *
 * @param file The changed file this item represents.
 * @param formatterId Id of the formatter that applies, or `undefined` if the
 *        file will be shown as a plain (unformatted) diff.
 */
export class ChangedFileItem extends vscode.TreeItem {
  constructor(
    public readonly file: ChangedFile,
    formatterId: string | undefined,
  ) {
    super(file.fileName, vscode.TreeItemCollapsibleState.None);
    // Surface the formatter inline so users can tell which files get the pretty
    // treatment versus a plain diff.
    this.description =
      formatterId === undefined
        ? file.relativePath
        : `${file.relativePath} · ${formatterId}`;
    this.tooltip =
      formatterId === undefined
        ? `${file.uri.fsPath}\n(plain diff — no formatter)`
        : `${file.uri.fsPath}\n(pretty diff — ${formatterId})`;
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
 * Centralised so the list can be narrowed in the future if desired.
 */
export type FileFilter = (file: ChangedFile) => boolean;

/** Default filter: show every changed file in the working tree. */
export const allChangesFilter: FileFilter = () => true;

/**
 * Supplies the GitLineDiff Source Control view with the list of changed files
 * that pass the configured {@link FileFilter}. Refreshes automatically when the
 * Git repository state changes.
 *
 * @param getRegistry Returns the current formatter registry. A getter (rather
 *        than a fixed instance) lets the view reflect live configuration
 *        changes that rebuild the registry.
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
    private readonly getRegistry: () => FormatterRegistry,
    private readonly filter: FileFilter = allChangesFilter,
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
    const registry = this.getRegistry();
    return this.gitApi
      .getWorkingTreeChanges()
      .filter(this.filter)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((file) => new ChangedFileItem(file, registry.resolve(file.uri.fsPath)?.id));
  }

  public dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

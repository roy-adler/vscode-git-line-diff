import * as vscode from 'vscode';
import { GitApi, type CommitDiffFile } from './gitApi';
import { buildRegistry, FormatterRegistry } from './formatterRegistry';
import { ChangedFileItem, GitLineDiffTreeProvider, OPEN_DIFF_COMMAND } from './treeView';
import { readConfig, affectsConfig } from './config';
import { GitLineDiffGraphPanel } from './graphView';

/** Command that opens a commit's multi-file pretty diff. */
const OPEN_COMMIT_DIFF_COMMAND = 'gitlinediff.openCommitDiff';

/** Command that opens the commit graph panel. */
const OPEN_GRAPH_COMMAND = 'gitlinediff.openGraph';

/** Custom URI scheme backing the in-memory, pretty-printed virtual documents. */
const SCHEME = 'gitlinediff';

/** View identifier declared in `package.json` -> contributes.views.scm. */
const VIEW_ID = 'gitLineDiffView';

/**
 * Which revision of a file a virtual document represents. `WORKING_REF` reads
 * from disk; any other value is a git ref (e.g. `HEAD`, a commit hash, or a
 * parent commit) read through the Git API.
 */
const WORKING_REF = 'working';
const HEAD_REF = 'HEAD';

/** Query keys used to encode state inside a virtual URI. */
const QUERY_REF = 'ref';
const QUERY_SRC = 'src';

/**
 * Provides pretty-printed, read-only virtual documents for the `gitlinediff`
 * scheme. Content is produced on demand and held only in memory — the original
 * files on disk are never touched.
 *
 * Each virtual URI encodes:
 *  - the path of the original file (preserved as the URI path so VS Code infers
 *    the correct language for syntax highlighting), and
 *  - a `ref` (`working` or any git ref) plus the original file path in the
 *    query.
 */
class PrettyDiffContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  /** Signals VS Code to re-query content for the emitted URIs. */
  public readonly onDidChange: vscode.Event<vscode.Uri> = this.onDidChangeEmitter.event;

  private readonly subscription: vscode.Disposable;

  /**
   * @param gitApi Source of file content.
   * @param getRegistry Returns the current formatter registry. A getter lets a
   *        config-driven registry rebuild take effect without re-registering
   *        the provider.
   */
  constructor(
    private readonly gitApi: GitApi,
    private readonly getRegistry: () => FormatterRegistry,
  ) {
    // When the repository changes, invalidate every changed file so any open
    // diff editors re-render with fresh, re-formatted content.
    this.subscription = this.gitApi.onDidChange(() => this.refreshAll());
  }

  /**
   * Invalidates both sides of every changed file, forcing open diff editors to
   * re-query content (e.g. after a repo change or a settings change).
   */
  public refreshAll(): void {
    for (const file of this.gitApi.getWorkingTreeChanges()) {
      this.onDidChangeEmitter.fire(
        PrettyDiffContentProvider.buildUri(file.uri.fsPath, HEAD_REF),
      );
      this.onDidChangeEmitter.fire(
        PrettyDiffContentProvider.buildUri(file.uri.fsPath, WORKING_REF),
      );
    }
  }

  public dispose(): void {
    this.subscription.dispose();
    this.onDidChangeEmitter.dispose();
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const ref = params.get(QUERY_REF) ?? WORKING_REF;
    const src = params.get(QUERY_SRC);
    if (src === null) {
      return '';
    }

    const sourceUri = vscode.Uri.file(src);
    let raw: string;
    if (ref === WORKING_REF) {
      // The working-tree file may not exist (deleted file, or the source was a
      // virtual diff side). Treat a missing file as empty rather than throwing,
      // which would surface as an "unable to open" error in the diff editor.
      try {
        raw = await this.gitApi.readWorkingTree(sourceUri);
      } catch {
        raw = '';
      }
    } else {
      raw = await this.gitApi.readRef(ref, sourceUri);
    }

    // Transform through the registry before display. Unknown types or parse
    // failures fall back to the original content inside the formatter.
    return this.getRegistry().format(src, raw);
  }

  /**
   * Builds a virtual URI for one side of the diff.
   *
   * @param sourceFsPath Absolute path of the real file.
   * @param ref `WORKING_REF` or any git ref (e.g. `HEAD` / commit hash).
   */
  public static buildUri(sourceFsPath: string, ref: string): vscode.Uri {
    const query = new URLSearchParams({
      [QUERY_REF]: ref,
      [QUERY_SRC]: sourceFsPath,
    }).toString();

    // Keep the original path so the editor title and language match the file.
    return vscode.Uri.from({
      scheme: SCHEME,
      path: sourceFsPath,
      query,
    });
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const gitApi = new GitApi();

  // The registry is rebuilt from settings whenever configuration changes; a
  // mutable reference plus a getter keeps every consumer pointed at the latest.
  let registry = buildRegistry(readConfig());
  const getRegistry = (): FormatterRegistry => registry;

  const ready = await gitApi.initialize();
  if (!ready) {
    void vscode.window.showWarningMessage(
      'GitLineDiff: the built-in Git extension is not available.',
    );
  }

  // Register the virtual document provider for our custom scheme.
  const contentProvider = new PrettyDiffContentProvider(gitApi, getRegistry);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
    contentProvider,
  );

  // Register the Source Control tree view.
  const treeProvider = new GitLineDiffTreeProvider(gitApi, getRegistry);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(VIEW_ID, treeProvider),
    treeProvider,
    gitApi,
  );

  // Rebuild the registry and re-render when GitLineDiff settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!affectsConfig(event)) {
        return;
      }
      registry = buildRegistry(readConfig());
      treeProvider.refresh();
      contentProvider.refreshAll();
    }),
  );

  // Opens a commit's multi-file pretty diff (commit vs its parent).
  const openCommitDiff = async (hash: string): Promise<void> => {
    const diff = await gitApi.getCommitDiff(hash);
    if (diff.files.length === 0) {
      void vscode.window.showInformationMessage(
        `GitLineDiff: no file changes found for ${hash.slice(0, 7)}.`,
      );
      return;
    }

    const resources = diff.files.map((file) => ({
      originalUri: PrettyDiffContentProvider.buildUri(file.originalUri.fsPath, diff.baseRef),
      modifiedUri: PrettyDiffContentProvider.buildUri(file.uri.fsPath, diff.commitRef),
    }));
    const title = `GitLineDiff: ${hash.slice(0, 7)}`;

    try {
      // Preferred: a single scrollable multi-file diff.
      await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
        title,
        resources,
      });
    } catch {
      // Fallback for hosts without the multi-diff editor: one diff tab per file.
      for (const file of diff.files) {
        await vscode.commands.executeCommand(
          'vscode.diff',
          PrettyDiffContentProvider.buildUri(file.originalUri.fsPath, diff.baseRef),
          PrettyDiffContentProvider.buildUri(file.uri.fsPath, diff.commitRef),
          `${basename(file.uri.fsPath)} @ ${hash.slice(0, 7)}`,
        );
      }
    }
  };

  // Opens a single file's pretty diff for a commit (parent revision vs commit).
  const openCommitFile = async (
    baseRef: string,
    commitRef: string,
    file: CommitDiffFile,
  ): Promise<void> => {
    const leftUri = PrettyDiffContentProvider.buildUri(file.originalUri.fsPath, baseRef);
    const rightUri = PrettyDiffContentProvider.buildUri(file.uri.fsPath, commitRef);
    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      `GitLineDiff: ${basename(file.uri.fsPath)} @ ${commitRef.slice(0, 7)}`,
    );
  };

  // Commit-graph panel (opens full-width in the editor area on demand). Clicking
  // a commit expands an inline detail panel; clicking a file opens its pretty diff.
  const graphPanel = new GitLineDiffGraphPanel(
    gitApi,
    (baseRef, commitRef, file) => {
      void openCommitFile(baseRef, commitRef, file);
    },
    context.extensionUri,
  );
  context.subscriptions.push(
    graphPanel,
    vscode.commands.registerCommand(OPEN_GRAPH_COMMAND, () => graphPanel.show()),
  );

  // Status-bar button to open the graph (like Git Graph).
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  statusBarItem.text = '$(git-commit) GitLineDiff Graph';
  statusBarItem.tooltip = 'Open the GitLineDiff commit graph';
  statusBarItem.command = OPEN_GRAPH_COMMAND;
  if (ready) {
    statusBarItem.show();
  }
  context.subscriptions.push(statusBarItem);

  // Command: open a pretty diff for the selected file. The argument shape
  // varies by source (tree item, SCM resource, Explorer/editor URI); the
  // resolver normalises all of them.
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_DIFF_COMMAND, async (arg?: unknown) => {
      const target = resolveDiffTarget(arg);
      if (target === undefined) {
        void vscode.window.showInformationMessage(
          'GitLineDiff: no file to diff here. Open a file or pick one from the changes list.',
        );
        return;
      }
      try {
        await openPrettyDiff(target);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`GitLineDiff: could not open diff. ${detail}`);
      }
    }),
  );

  // Command: open a commit's pretty diff. With no argument, prompts the user to
  // pick a commit; the graph view passes a hash directly.
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_COMMIT_DIFF_COMMAND, async (arg?: unknown) => {
      let hash = typeof arg === 'string' ? arg : undefined;
      if (hash === undefined) {
        hash = await pickCommit(gitApi);
      }
      if (hash !== undefined) {
        await openCommitDiff(hash);
      }
    }),
  );

  // Command: refresh the file view and the graph (if open) manually.
  context.subscriptions.push(
    vscode.commands.registerCommand('gitlinediff.refresh', () => {
      treeProvider.refresh();
      graphPanel.refresh();
    }),
  );
}

/** A normalised target for a working-tree pretty diff. */
interface DiffTarget {
  readonly uri: vscode.Uri;
  readonly fileName: string;
}

/** Returns the file name from a path, normalising separators. */
function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
}

/**
 * Normalises a command argument into a {@link DiffTarget}. Handles our tree
 * item, an SCM resource state (`.resourceUri`), a raw `Uri` (Explorer / editor
 * tab), our `ChangedFile` (`.uri`), or `undefined` (falls back to the active
 * editor).
 */
function resolveDiffTarget(arg: unknown): DiffTarget | undefined {
  if (arg === undefined) {
    const active = vscode.window.activeTextEditor?.document.uri;
    return active === undefined ? undefined : toFileTarget(active);
  }
  if (arg instanceof ChangedFileItem) {
    return { uri: arg.file.uri, fileName: arg.file.fileName };
  }
  if (arg instanceof vscode.Uri) {
    return toFileTarget(arg);
  }
  const record = arg as { uri?: unknown; resourceUri?: unknown; fileName?: unknown };
  if (record.resourceUri instanceof vscode.Uri) {
    return toFileTarget(record.resourceUri);
  }
  if (record.uri instanceof vscode.Uri) {
    const target = toFileTarget(record.uri);
    if (target !== undefined && typeof record.fileName === 'string') {
      return { uri: target.uri, fileName: record.fileName };
    }
    return target;
  }
  return undefined;
}

/**
 * Normalises any editor/diff URI to a real on-disk `file:` target. Diff editors
 * (built-in `git:` diffs, or our own `gitlinediff:` pretty diffs) expose virtual
 * URIs; this maps them back to the underlying working-tree file so a fresh
 * pretty diff can be opened. Returns `undefined` for resources with no real path.
 */
function toFileTarget(uri: vscode.Uri): DiffTarget | undefined {
  if (uri.scheme === 'file') {
    return { uri, fileName: basename(uri.fsPath) };
  }
  if (uri.scheme === SCHEME) {
    // Our virtual scheme carries the real path in the `src` query param.
    const src = new URLSearchParams(uri.query).get(QUERY_SRC);
    if (src !== null && src !== '') {
      const fileUri = vscode.Uri.file(src);
      return { uri: fileUri, fileName: basename(fileUri.fsPath) };
    }
  }
  if (uri.scheme === 'git') {
    // The built-in Git scheme encodes the file path as JSON in the query.
    try {
      const parsed = JSON.parse(uri.query) as { path?: unknown };
      if (typeof parsed.path === 'string' && parsed.path !== '') {
        const fileUri = vscode.Uri.file(parsed.path);
        return { uri: fileUri, fileName: basename(fileUri.fsPath) };
      }
    } catch {
      // Fall through to the generic fsPath handling below.
    }
  }
  // Last resort: use the URI's fsPath if it looks like an absolute path.
  const fsPath = uri.fsPath;
  if (fsPath !== '' && (fsPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(fsPath))) {
    return { uri: vscode.Uri.file(fsPath), fileName: basename(fsPath) };
  }
  return undefined;
}

/** Prompts the user to choose a commit; returns its hash or `undefined`. */
async function pickCommit(gitApi: GitApi): Promise<string | undefined> {
  const commits = await gitApi.getRecentCommits(100);
  if (commits.length === 0) {
    void vscode.window.showInformationMessage('GitLineDiff: no commits found.');
    return undefined;
  }

  interface CommitPick extends vscode.QuickPickItem {
    readonly hash: string;
  }
  const items: CommitPick[] = commits.map((commit) => ({
    label: commit.message.split('\n', 1)[0]?.trim() || '(no message)',
    description: commit.hash.slice(0, 7),
    detail: commit.authorName,
    hash: commit.hash,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a commit to open its pretty diff (vs parent)',
    matchOnDescription: true,
  });
  return pick?.hash;
}

/**
 * Opens a diff editor comparing the pretty-printed `HEAD` and working-tree
 * versions of a file. Both sides flow through the formatter registry.
 */
async function openPrettyDiff(target: DiffTarget): Promise<void> {
  const fsPath = target.uri.fsPath;
  // Left = committed baseline (HEAD), right = current working tree.
  const leftUri = PrettyDiffContentProvider.buildUri(fsPath, HEAD_REF);
  const rightUri = PrettyDiffContentProvider.buildUri(fsPath, WORKING_REF);

  await vscode.commands.executeCommand(
    'vscode.diff',
    leftUri,
    rightUri,
    `GitLineDiff: ${target.fileName}`,
  );
}

export function deactivate(): void {
  // Disposables are cleaned up via `context.subscriptions`.
}

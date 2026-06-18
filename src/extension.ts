import * as vscode from 'vscode';
import { GitApi, type CommitDiffFile } from './gitApi';
import { buildRegistry, FormatterRegistry } from './formatterRegistry';
import { ChangedFileItem, GitLineDiffTreeProvider, OPEN_DIFF_COMMAND } from './treeView';
import { readConfig, affectsConfig } from './config';
import { GitLineDiffGraphPanel } from './graphView';
import {
  buildDiffSideMetadata,
  detectSerializationFormat,
  type DiffSideMetadata,
  type EmbeddedScanOptions,
  type StructuredFormatOptions,
} from './structuredData';

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
const QUERY_SIDE = 'side';
const QUERY_PAIR_REF = 'pairRef';

/** Which side of a diff a virtual document represents. */
type DiffSide = 'original' | 'modified';

/** Metadata keyed by virtual URI string for tab/file decorations. */
const sideMetadata = new Map<string, DiffSideMetadata>();

/** Signals VS Code to refresh file decorations for GitLineDiff virtual docs. */
const decorationChangeEmitter = new vscode.EventEmitter<
  vscode.Uri | vscode.Uri[] | undefined
>();

/**
 * Renders origin and cross-format conversion badges on GitLineDiff diff tabs
 * without injecting banners into the document text.
 */
class GitLineDiffFileDecorationProvider implements vscode.FileDecorationProvider {
  public readonly onDidChangeFileDecorations = decorationChangeEmitter.event;

  public provideFileDecoration(
    uri: vscode.Uri,
  ): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== SCHEME) {
      return undefined;
    }
    const metadata = sideMetadata.get(uri.toString());
    if (metadata === undefined) {
      return undefined;
    }

    if (metadata.conversion !== undefined) {
      const badge = metadata.conversion === 'yaml-to-json' ? 'Y→J' : 'J→Y';
      const tooltip =
        metadata.conversion === 'yaml-to-json'
          ? 'GitLineDiff · converted YAML → JSON for comparison'
          : 'GitLineDiff · converted JSON → YAML for comparison';
      return new vscode.FileDecoration(badge, tooltip);
    }

    const badge = metadata.originFormat === 'json' ? 'JSON' : 'YAML';
    return new vscode.FileDecoration(
      badge,
      `GitLineDiff · origin: ${metadata.originFormat.toUpperCase()}`,
    );
  }
}

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
        PrettyDiffContentProvider.buildUri(file.uri.fsPath, HEAD_REF, {
          side: 'original',
          pairRef: WORKING_REF,
        }),
      );
      this.onDidChangeEmitter.fire(
        PrettyDiffContentProvider.buildUri(file.uri.fsPath, WORKING_REF, {
          side: 'modified',
          pairRef: HEAD_REF,
        }),
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
    const side = params.get(QUERY_SIDE) as DiffSide | null;
    const pairRef = params.get(QUERY_PAIR_REF);
    if (src === null) {
      return '';
    }

    const sourceUri = vscode.Uri.file(src);
    const raw = await this.readRevision(ref, sourceUri);
    const config = readConfig();
    const embeddedScan = toEmbeddedScanOptions(config);

    let structured: StructuredFormatOptions = {
      crossFormatCompare: config.structuredData.canonicalizeToJson,
    };

    if (side !== null && pairRef !== null && config.structuredData.canonicalizeToJson) {
      const pairRaw = await this.readRevision(pairRef, sourceUri);
      const modifiedRaw = side === 'modified' ? raw : pairRaw;
      const targetSerialization = detectSerializationFormat(
        modifiedRaw,
        src,
        embeddedScan,
      );
      if (targetSerialization !== undefined) {
        structured = {
          crossFormatCompare: true,
          targetSerialization,
        };
      }

      const metadata = buildDiffSideMetadata(
        src,
        raw,
        side,
        structured,
        embeddedScan,
      );
      if (metadata === undefined) {
        sideMetadata.delete(uri.toString());
      } else {
        sideMetadata.set(uri.toString(), metadata);
      }
      decorationChangeEmitter.fire(uri);
    }

    // Transform through the registry before display. Unknown types or parse
    // failures fall back to the original content inside the formatter.
    return this.getRegistry().format(src, raw, { structured });
  }

  private async readRevision(ref: string, sourceUri: vscode.Uri): Promise<string> {
    if (ref === WORKING_REF) {
      // The working-tree file may not exist (deleted file, or the source was a
      // virtual diff side). Treat a missing file as empty rather than throwing,
      // which would surface as an "unable to open" error in the diff editor.
      try {
        return await this.gitApi.readWorkingTree(sourceUri);
      } catch {
        return '';
      }
    }
    return this.gitApi.readRef(ref, sourceUri);
  }

  /**
   * Builds a virtual URI for one side of the diff.
   *
   * @param sourceFsPath Absolute path of the real file.
   * @param ref `WORKING_REF` or any git ref (e.g. `HEAD` / commit hash).
   */
  public static buildUri(
    sourceFsPath: string,
    ref: string,
    diff?: { readonly side: DiffSide; readonly pairRef: string },
  ): vscode.Uri {
    const queryParams: Record<string, string> = {
      [QUERY_REF]: ref,
      [QUERY_SRC]: sourceFsPath,
    };
    if (diff !== undefined) {
      queryParams[QUERY_SIDE] = diff.side;
      queryParams[QUERY_PAIR_REF] = diff.pairRef;
    }
    const query = new URLSearchParams(queryParams).toString();

    // Keep the original path so the editor title and language match the file.
    return vscode.Uri.from({
      scheme: SCHEME,
      path: sourceFsPath,
      query,
    });
  }
}

function toEmbeddedScanOptions(
  config: ReturnType<typeof readConfig>,
): EmbeddedScanOptions | undefined {
  if (!config.embeddedJson.enabled) {
    return undefined;
  }
  return {
    autoDetect: config.embeddedJson.autoDetect,
    keys: config.embeddedJson.keys,
    keyPattern: config.embeddedJson.keyPattern,
  };
}

/** Diagnostic output channel (View → Output → "GitLineDiff"). */
let logChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logChannel = vscode.window.createOutputChannel('GitLineDiff');
  context.subscriptions.push(logChannel);

  const gitApi = new GitApi();

  // The registry is rebuilt from settings whenever configuration changes; a
  // mutable reference plus a getter keeps every consumer pointed at the latest.
  let registry = buildRegistry(readConfig());
  const getRegistry = (): FormatterRegistry => registry;

  const ready = await gitApi.ensureInitialized();
  if (!ready) {
    logChannel.appendLine(
      'Git extension not ready at activation; will retry when it becomes available.',
    );
  }

  // Register the virtual document provider for our custom scheme.
  const contentProvider = new PrettyDiffContentProvider(gitApi, getRegistry);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
    contentProvider,
    vscode.window.registerFileDecorationProvider(new GitLineDiffFileDecorationProvider()),
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
      originalUri: PrettyDiffContentProvider.buildUri(file.originalUri.fsPath, diff.baseRef, {
        side: 'original',
        pairRef: diff.commitRef,
      }),
      modifiedUri: PrettyDiffContentProvider.buildUri(file.uri.fsPath, diff.commitRef, {
        side: 'modified',
        pairRef: diff.baseRef,
      }),
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
          PrettyDiffContentProvider.buildUri(file.originalUri.fsPath, diff.baseRef, {
            side: 'original',
            pairRef: diff.commitRef,
          }),
          PrettyDiffContentProvider.buildUri(file.uri.fsPath, diff.commitRef, {
            side: 'modified',
            pairRef: diff.baseRef,
          }),
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
    const leftUri = PrettyDiffContentProvider.buildUri(file.originalUri.fsPath, baseRef, {
      side: 'original',
      pairRef: commitRef,
    });
    const rightUri = PrettyDiffContentProvider.buildUri(file.uri.fsPath, commitRef, {
      side: 'modified',
      pairRef: baseRef,
    });
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
    vscode.commands.registerCommand(OPEN_GRAPH_COMMAND, async () => {
      if (!(await gitApi.ensureInitialized()) || gitApi.getPrimaryRepository() === undefined) {
        void vscode.window.showInformationMessage(
          'GitLineDiff: open a folder with a git repository first.',
        );
        return;
      }
      graphPanel.show();
    }),
  );

  // Status-bar button to open the graph (like Git Graph).
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  statusBarItem.text = '$(git-commit) GitLineDiff Graph';
  statusBarItem.tooltip = 'Open the GitLineDiff commit graph';
  statusBarItem.command = OPEN_GRAPH_COMMAND;
  // Show immediately; the graph command handles a missing repository gracefully.
  statusBarItem.show();

  const refreshGitIntegration = async (): Promise<void> => {
    const ok = await gitApi.ensureInitialized();
    if (ok) {
      statusBarItem.show();
      treeProvider.refresh();
    }
  };

  // The built-in Git extension often activates only after the SCM view is opened.
  // Retry when extensions change or repositories become available.
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => {
      void refreshGitIntegration();
    }),
    gitApi.onDidChange(() => {
      statusBarItem.show();
    }),
  );
  if (!ready) {
    void refreshGitIntegration();
  }

  context.subscriptions.push(statusBarItem);

  // Command: open a pretty diff for the selected file. The argument shape
  // varies by source (tree item, SCM resource, Explorer/editor URI); the
  // resolver normalises all of them.
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_DIFF_COMMAND, async (arg?: unknown) => {
      const argDesc = describeArg(arg);
      logChannel.appendLine(`openDiff invoked with arg: ${argDesc}`);
      const target = resolveDiffTarget(arg);
      if (target === undefined) {
        logChannel.appendLine('openDiff: could not resolve a target.');
        void vscode.window.showInformationMessage(
          'GitLineDiff: no file to diff here. Open a file or pick one from the changes list.',
        );
        return;
      }
      logChannel.appendLine(`openDiff: resolved target -> ${target.uri.toString()}`);

      // Guard against opening a blank diff: if the resolved working-tree file
      // doesn't exist on disk, there's nothing to diff (HEAD vs working would be
      // empty/empty). Tell the user instead of overwriting their diff.
      let exists = false;
      try {
        await vscode.workspace.fs.stat(target.uri);
        exists = true;
      } catch {
        exists = false;
      }
      if (!exists) {
        logChannel.appendLine(`openDiff: working file not found at ${target.uri.fsPath}`);
        void vscode.window.showWarningMessage(
          `GitLineDiff: couldn't resolve a working-tree file. arg=${argDesc}`,
        );
        return;
      }

      try {
        await openPrettyDiff(target);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logChannel.appendLine(`openDiff: error - ${detail}`);
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

/** Builds a human-readable description of a command argument for diagnostics. */
function describeArg(arg: unknown): string {
  if (arg === undefined) {
    return 'undefined (will use active editor)';
  }
  if (arg instanceof vscode.Uri) {
    return `Uri{ scheme=${arg.scheme}, fsPath=${arg.fsPath}, query=${arg.query} }`;
  }
  if (arg instanceof ChangedFileItem) {
    return `ChangedFileItem{ ${arg.file.uri.toString()} }`;
  }
  const record = arg as { uri?: unknown; resourceUri?: unknown };
  if (record.resourceUri instanceof vscode.Uri) {
    return `obj.resourceUri{ scheme=${record.resourceUri.scheme}, ${record.resourceUri.toString()} }`;
  }
  if (record.uri instanceof vscode.Uri) {
    return `obj.uri{ scheme=${record.uri.scheme}, ${record.uri.toString()} }`;
  }
  try {
    return `${typeof arg}: ${JSON.stringify(arg)}`;
  } catch {
    return `${typeof arg} (unserialisable)`;
  }
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
  const leftUri = PrettyDiffContentProvider.buildUri(fsPath, HEAD_REF, {
    side: 'original',
    pairRef: WORKING_REF,
  });
  const rightUri = PrettyDiffContentProvider.buildUri(fsPath, WORKING_REF, {
    side: 'modified',
    pairRef: HEAD_REF,
  });

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

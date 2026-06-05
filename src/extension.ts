import * as vscode from 'vscode';
import { GitApi, type ChangedFile } from './gitApi';
import { buildRegistry, FormatterRegistry } from './formatterRegistry';
import { ChangedFileItem, GitLineDiffTreeProvider, OPEN_DIFF_COMMAND } from './treeView';
import { readConfig, affectsConfig } from './config';

/** Custom URI scheme backing the in-memory, pretty-printed virtual documents. */
const SCHEME = 'gitlinediff';

/** View identifier declared in `package.json` -> contributes.views.scm. */
const VIEW_ID = 'gitLineDiffView';

/** Which revision of a file a virtual document represents. */
type Ref = 'working' | 'head';

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
 *  - a `ref` (`working` | `head`) plus the original file path in the query.
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
        PrettyDiffContentProvider.buildUri(file.uri.fsPath, 'head'),
      );
      this.onDidChangeEmitter.fire(
        PrettyDiffContentProvider.buildUri(file.uri.fsPath, 'working'),
      );
    }
  }

  public dispose(): void {
    this.subscription.dispose();
    this.onDidChangeEmitter.dispose();
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const ref = (params.get(QUERY_REF) as Ref | null) ?? 'working';
    const src = params.get(QUERY_SRC);
    if (src === null) {
      return '';
    }

    const sourceUri = vscode.Uri.file(src);
    const raw =
      ref === 'head'
        ? await this.gitApi.readHead(sourceUri)
        : await this.gitApi.readWorkingTree(sourceUri);

    // Transform through the registry before display. Unknown types or parse
    // failures fall back to the original content inside the formatter.
    return this.getRegistry().format(src, raw);
  }

  /**
   * Builds a virtual URI for one side of the diff.
   *
   * @param sourceFsPath Absolute path of the real file.
   * @param ref Which revision this side represents.
   */
  public static buildUri(sourceFsPath: string, ref: Ref): vscode.Uri {
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

  // Command: open a pretty diff for the selected file. The argument differs by
  // invocation source: clicking the row passes the `ChangedFile` we attached to
  // the item's command, while the inline menu button passes the
  // `ChangedFileItem` tree node. Normalise both into a `ChangedFile`.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      OPEN_DIFF_COMMAND,
      async (arg?: ChangedFile | ChangedFileItem) => {
        const file = resolveChangedFile(arg);
        if (file === undefined) {
          return;
        }
        await openPrettyDiff(file);
      },
    ),
  );

  // Command: refresh the view manually.
  context.subscriptions.push(
    vscode.commands.registerCommand('gitlinediff.refresh', () => treeProvider.refresh()),
  );
}

/**
 * Normalises the command argument into a {@link ChangedFile}. Accepts the
 * `ChangedFile` attached to a tree item's command, a `ChangedFileItem` passed
 * by the inline menu contribution, or `undefined` (e.g. command palette).
 */
function resolveChangedFile(
  arg: ChangedFile | ChangedFileItem | undefined,
): ChangedFile | undefined {
  if (arg === undefined) {
    return undefined;
  }
  if (arg instanceof ChangedFileItem) {
    return arg.file;
  }
  // Defensive: only accept objects that actually carry a URI.
  return arg.uri instanceof vscode.Uri ? arg : undefined;
}

/**
 * Opens a diff editor comparing the pretty-printed `HEAD` and working-tree
 * versions of a file. Both sides flow through the formatter registry.
 */
async function openPrettyDiff(file: ChangedFile): Promise<void> {
  const fsPath = file.uri.fsPath;
  // Left = committed baseline (HEAD), right = current working tree.
  const leftUri = PrettyDiffContentProvider.buildUri(fsPath, 'head');
  const rightUri = PrettyDiffContentProvider.buildUri(fsPath, 'working');

  await vscode.commands.executeCommand(
    'vscode.diff',
    leftUri,
    rightUri,
    `GitLineDiff: ${file.fileName}`,
  );
}

export function deactivate(): void {
  // Disposables are cleaned up via `context.subscriptions`.
}

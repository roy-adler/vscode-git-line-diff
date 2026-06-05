import * as vscode from 'vscode';
import type { API, GitExtension, Repository, Change } from './git';

/** Identifier of the built-in VS Code Git extension. */
const GIT_EXTENSION_ID = 'vscode.git';

/** Git ref used to read the committed (baseline) version of a file. */
export const HEAD_REF = 'HEAD';

/**
 * A changed file surfaced by the extension. This is a thin, decoupled view over
 * the Git extension's `Change` so the rest of the codebase does not depend on
 * Git API internals.
 */
export interface ChangedFile {
  /** Absolute on-disk URI of the working-tree file. */
  readonly uri: vscode.Uri;
  /** File name only (no directory), used for labels. */
  readonly fileName: string;
  /** Path relative to the repository root, used for descriptions. */
  readonly relativePath: string;
}

/**
 * Wraps the built-in Git extension and exposes a small, strongly-typed surface
 * tailored to GitLineDiff's needs.
 *
 * Responsibilities:
 *  - Acquire the Git API and activate the host extension if needed.
 *  - Enumerate working-tree changes.
 *  - Read file content from the working tree and from `HEAD`.
 *  - Notify listeners when the underlying repository state changes.
 */
export class GitApi implements vscode.Disposable {
  private api: API | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /** Fires when repositories open/close or their state changes. */
  public readonly onDidChange: vscode.Event<void> = this.onDidChangeEmitter.event;

  /**
   * Activates the Git extension (if present) and wires up change notifications.
   *
   * @returns `true` if the Git API became available, `false` otherwise.
   */
  public async initialize(): Promise<boolean> {
    const extension = vscode.extensions.getExtension<GitExtension>(GIT_EXTENSION_ID);
    if (extension === undefined) {
      return false;
    }

    const exports = extension.isActive ? extension.exports : await extension.activate();
    this.api = exports.getAPI(1);

    // Re-emit on repository lifecycle changes so the tree view can refresh.
    this.disposables.push(
      this.api.onDidOpenRepository((repository) => {
        this.subscribeToRepository(repository);
        this.onDidChangeEmitter.fire();
      }),
      this.api.onDidCloseRepository(() => this.onDidChangeEmitter.fire()),
    );

    // Subscribe to repositories that already exist at activation time.
    for (const repository of this.api.repositories) {
      this.subscribeToRepository(repository);
    }

    return true;
  }

  /**
   * Returns the first available repository, or `undefined` if none is open.
   *
   * GitLineDiff operates on the currently opened repository; multi-repo
   * support can be layered on later by exposing all repositories.
   */
  public getPrimaryRepository(): Repository | undefined {
    return this.api?.repositories[0];
  }

  /**
   * Lists the working-tree changes of the primary repository, mapped into the
   * decoupled {@link ChangedFile} shape.
   */
  public getWorkingTreeChanges(): ChangedFile[] {
    const repository = this.getPrimaryRepository();
    if (repository === undefined) {
      return [];
    }

    const rootPath = repository.rootUri.fsPath;
    return repository.state.workingTreeChanges.map((change: Change): ChangedFile => {
      const filePath = change.uri.fsPath;
      return {
        uri: change.uri,
        fileName: GitApi.basename(filePath),
        relativePath: GitApi.toRelative(rootPath, filePath),
      };
    });
  }

  /**
   * Reads the current working-tree content of a file from disk.
   */
  public async readWorkingTree(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  }

  /**
   * Reads the `HEAD` (committed) version of a file via the Git API.
   *
   * @returns The file content at `HEAD`, or an empty string if the file does
   *          not exist at `HEAD` (e.g. a newly added file).
   */
  public async readHead(uri: vscode.Uri): Promise<string> {
    const repository = this.getPrimaryRepository();
    if (repository === undefined) {
      return '';
    }
    try {
      return await repository.show(HEAD_REF, uri.fsPath);
    } catch {
      // File is likely untracked / added and has no HEAD revision.
      return '';
    }
  }

  /** Subscribes to a repository's state changes and re-emits them. */
  private subscribeToRepository(repository: Repository): void {
    this.disposables.push(
      repository.state.onDidChange(() => this.onDidChangeEmitter.fire()),
    );
  }

  /** Returns the file name from a path, normalising separators. */
  private static basename(filePath: string): string {
    return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  }

  /** Returns `filePath` relative to `root`, normalised to forward slashes. */
  private static toRelative(root: string, filePath: string): string {
    const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
      return normalizedPath.slice(normalizedRoot.length + 1);
    }
    return normalizedPath;
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

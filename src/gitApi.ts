import * as vscode from 'vscode';
import { RefType } from './git';
import type { API, GitExtension, Repository, Change, Commit, Ref } from './git';

/** Identifier of the built-in VS Code Git extension. */
const GIT_EXTENSION_ID = 'vscode.git';

/** Git ref used to read the committed (baseline) version of a file. */
export const HEAD_REF = 'HEAD';

/**
 * The well-known SHA of git's empty tree. Used as the base when diffing the
 * repository's root commit (which has no parent).
 */
const EMPTY_TREE_REF = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A single file's change within a specific commit (parent -> commit). */
export interface CommitDiffFile {
  /** Path of the file at the parent revision (differs on rename). */
  readonly originalUri: vscode.Uri;
  /** Path of the file at the commit revision. */
  readonly uri: vscode.Uri;
  /** Path relative to the repository root, for display. */
  readonly relativePath: string;
}

/** A branch entry for the graph's branch-filter dropdown. */
export interface BranchInfo {
  /** Branch name (short for local, `remote/name` for remotes). */
  readonly name: string;
  /** True for a remote-tracking branch. */
  readonly remote: boolean;
  /** True for the currently checked-out branch (HEAD). */
  readonly current: boolean;
}

/** A ref label attached to a commit, for rendering badges in the graph. */
export interface RefLabel {
  readonly name: string;
  readonly kind: 'head' | 'remote' | 'tag';
  /** True for the local branch currently checked out (HEAD). */
  readonly current: boolean;
}

/** The resolved diff for a commit: its base ref plus the changed files. */
export interface CommitDiff {
  /** The ref the commit is compared against (its first parent or empty tree). */
  readonly baseRef: string;
  /** The commit's own hash. */
  readonly commitRef: string;
  readonly files: CommitDiffFile[];
}

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

  /** Whether the built-in Git API has been acquired. */
  public isInitialized(): boolean {
    return this.api !== undefined;
  }

  /** Acquires the Git API if not already initialized. */
  public async ensureInitialized(): Promise<boolean> {
    if (this.api !== undefined) {
      return true;
    }
    return this.initialize();
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
   * Reads the version of a file at an arbitrary git ref (e.g. `HEAD`, a commit
   * hash, or a parent commit).
   *
   * @returns The file content at `ref`, or an empty string if the file does not
   *          exist at that ref (e.g. an added or deleted file).
   */
  public async readRef(ref: string, uri: vscode.Uri): Promise<string> {
    const repository = this.getPrimaryRepository();
    if (repository === undefined || ref === '') {
      return '';
    }
    try {
      return await repository.show(ref, uri.fsPath);
    } catch {
      // File doesn't exist at this ref (added/deleted/renamed).
      return '';
    }
  }

  /** Convenience wrapper for {@link readRef} at `HEAD`. */
  public readHead(uri: vscode.Uri): Promise<string> {
    return this.readRef(HEAD_REF, uri);
  }

  /**
   * Returns recent commits (most recent first), or `[]` if unavailable.
   *
   * @param maxEntries Maximum number of commits to return.
   * @param refNames   Revisions to log from (branch names). When omitted or
   *                   empty, logs from `HEAD`. Pass multiple branch tips to get
   *                   a unified "show all branches" history.
   */
  public async getRecentCommits(maxEntries = 50, refNames?: string[]): Promise<Commit[]> {
    const repository = this.getPrimaryRepository();
    if (repository === undefined) {
      return [];
    }
    const refs = refNames !== undefined && refNames.length > 0 ? refNames : undefined;
    try {
      return await repository.log({ maxEntries, refNames: refs });
    } catch {
      // Some Git API builds reject unknown refNames; fall back to HEAD history.
      try {
        return await repository.log({ maxEntries });
      } catch {
        return [];
      }
    }
  }

  /**
   * Lists the repository's branches for the graph's branch filter.
   *
   * @param includeRemote When `true`, remote-tracking branches are included.
   * @returns Branch entries (most relevant first), or `[]` if unavailable.
   */
  public async listBranches(includeRemote: boolean): Promise<BranchInfo[]> {
    const repository = this.getPrimaryRepository();
    if (repository === undefined) {
      return [];
    }
    const currentBranch = repository.state.HEAD?.name;
    let refs: Ref[];
    try {
      refs = await repository.getRefs({});
    } catch {
      return [];
    }

    const branches: BranchInfo[] = [];
    for (const ref of refs) {
      if (ref.name === undefined) {
        continue;
      }
      if (ref.type === RefType.Head) {
        branches.push({ name: ref.name, remote: false, current: ref.name === currentBranch });
      } else if (ref.type === RefType.RemoteHead && includeRemote) {
        branches.push({ name: ref.name, remote: true, current: false });
      }
    }

    // Current branch first, then local branches, then remotes; alphabetical within groups.
    const rank = (b: BranchInfo): number => (b.current ? 0 : b.remote ? 2 : 1);
    branches.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return branches;
  }

  /**
   * Builds a map from commit hash to the ref labels (branches, remote branches,
   * tags) pointing at it, for rendering badges in the graph.
   *
   * @param includeRemote When `false`, remote-tracking branch labels are omitted.
   */
  public async getRefsByCommit(includeRemote = true): Promise<Map<string, RefLabel[]>> {
    const map = new Map<string, RefLabel[]>();
    const repository = this.getPrimaryRepository();
    if (repository === undefined) {
      return map;
    }

    const currentBranch = repository.state.HEAD?.name;
    let refs: Ref[];
    try {
      refs = await repository.getRefs({});
    } catch {
      return map;
    }

    for (const ref of refs) {
      if (ref.commit === undefined || ref.name === undefined) {
        continue;
      }
      if (ref.type === RefType.RemoteHead && !includeRemote) {
        continue;
      }
      const kind: RefLabel['kind'] =
        ref.type === RefType.Tag
          ? 'tag'
          : ref.type === RefType.RemoteHead
            ? 'remote'
            : 'head';
      const label: RefLabel = {
        name: ref.name,
        kind,
        current: kind === 'head' && ref.name === currentBranch,
      };
      const list = map.get(ref.commit) ?? [];
      list.push(label);
      map.set(ref.commit, list);
    }

    // Order labels: current branch, other branches, remotes, then tags.
    const rank = (label: RefLabel): number =>
      label.current ? 0 : label.kind === 'head' ? 1 : label.kind === 'remote' ? 2 : 3;
    for (const list of map.values()) {
      list.sort((a, b) => rank(a) - rank(b));
    }
    return map;
  }

  /**
   * Checks out a branch shown on the graph. Local branches are checked out
   * directly; remote-tracking branches check out an existing local branch with
   * the same short name or create one tracking the remote.
   */
  public async checkoutRef(label: RefLabel): Promise<void> {
    const repository = this.getPrimaryRepository();
    if (repository === undefined) {
      throw new Error('No git repository is open.');
    }
    if (label.kind === 'tag') {
      throw new Error('Tags cannot be checked out from the graph.');
    }
    if (label.current) {
      return;
    }

    if (label.kind === 'head') {
      await repository.checkout(label.name);
      return;
    }

    // Remote-tracking ref (e.g. `origin/main`): prefer an existing local branch
    // with the same short name, otherwise create one from the remote.
    const slash = label.name.indexOf('/');
    const localName = slash !== -1 ? label.name.slice(slash + 1) : label.name;
    if (localName === '' || localName === 'HEAD') {
      await repository.checkout(label.name);
      return;
    }

    const refs = await repository.getRefs({});
    const hasLocal = refs.some(
      (ref) => ref.type === RefType.Head && ref.name === localName,
    );
    if (hasLocal) {
      await repository.checkout(localName);
    } else {
      await repository.createBranch(localName, true, label.name);
    }
  }

  /** Returns a commit's metadata, or `undefined` if unavailable. */
  public async getCommit(ref: string): Promise<Commit | undefined> {
    const repository = this.getPrimaryRepository();
    if (repository === undefined) {
      return undefined;
    }
    try {
      return await repository.getCommit(ref);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolves the changed files of a commit relative to its first parent (or the
   * empty tree for the root commit).
   */
  public async getCommitDiff(commitRef: string): Promise<CommitDiff> {
    const repository = this.getPrimaryRepository();
    const empty: CommitDiff = { baseRef: '', commitRef, files: [] };
    if (repository === undefined) {
      return empty;
    }

    try {
      const commit = await repository.getCommit(commitRef);
      const baseRef = commit.parents[0] ?? EMPTY_TREE_REF;
      const rootPath = repository.rootUri.fsPath;
      const changes = await repository.diffBetween(baseRef, commitRef);

      const files = changes.map((change: Change): CommitDiffFile => ({
        originalUri: change.originalUri,
        uri: change.uri,
        relativePath: GitApi.toRelative(rootPath, change.uri.fsPath),
      }));
      return { baseRef, commitRef, files };
    } catch {
      return empty;
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

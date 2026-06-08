/**
 * Minimal, strongly-typed subset of the built-in VS Code Git extension API.
 *
 * The official Git extension (`vscode.git`) does not ship its types on npm, so
 * we vendor only the parts this extension needs. The shapes mirror the public
 * API published at:
 *   https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 *
 * Keeping our own declaration lets `gitApi.ts` stay fully typed with no `any`.
 */

import { Uri, Event, Disposable } from 'vscode';

/** Status of a single change in a repository. */
export const enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,
  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED,
}

/** A single changed resource within a repository. */
export interface Change {
  /**
   * The original URI of the resource, before a rename. Equal to {@link uri}
   * for non-rename changes.
   */
  readonly originalUri: Uri;
  /** The current URI of the resource. */
  readonly uri: Uri;
  /** The git status of the change. */
  readonly status: Status;
}

/** A snapshot of the repository's working tree and index. */
export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  /** Changes staged in the index. */
  readonly indexChanges: Change[];
  /** Changes in the working tree (unstaged). */
  readonly workingTreeChanges: Change[];
  /** Merge conflicts. */
  readonly mergeChanges: Change[];
  /** Fires whenever the repository state changes. */
  readonly onDidChange: Event<void>;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
}

/** A commit returned by {@link Repository.log} / {@link Repository.getCommit}. */
export interface Commit {
  readonly hash: string;
  readonly message: string;
  /** Parent commit hashes. Empty for the root commit. */
  readonly parents: string[];
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly authorDate?: Date;
}

/** Options accepted by {@link Repository.log}. */
export interface LogOptions {
  /** Maximum number of commits to return. */
  readonly maxEntries?: number;
  /**
   * Revisions to log from (e.g. branch names). When omitted, logs from `HEAD`.
   * Multiple refs produce a unified history across those tips.
   */
  readonly refNames?: string[];
}

/** The kind of a git ref. Mirrors the Git extension's `RefType`. */
export const enum RefType {
  Head,
  RemoteHead,
  Tag,
}

/** A git ref (local branch, remote-tracking branch, or tag). */
export interface Ref {
  readonly type: RefType;
  readonly name?: string;
  /** Full commit hash the ref points at. */
  readonly commit?: string;
  readonly remote?: string;
}

/** Query accepted by {@link Repository.getRefs}. */
export interface RefQuery {
  readonly contains?: string;
  readonly count?: number;
  readonly pattern?: string;
}

export interface Repository {
  /** Filesystem root of the repository. */
  readonly rootUri: Uri;
  readonly state: RepositoryState;

  /**
   * Reads the content of a file at a given git revision (e.g. `"HEAD"`).
   *
   * @param ref A git ref such as `"HEAD"` or a commit hash.
   * @param path Absolute path to the file on disk.
   */
  show(ref: string, path: string): Promise<string>;

  /** Returns the commit metadata for a ref (e.g. a commit hash). */
  getCommit(ref: string): Promise<Commit>;

  /** Returns recent commits, most recent first. */
  log(options?: LogOptions): Promise<Commit[]>;

  /**
   * Returns the set of changes between two refs (`git diff ref1 ref2`).
   * Each {@link Change} carries `originalUri` (path at `ref1`) and `uri`
   * (path at `ref2`), accounting for renames.
   */
  diffBetween(ref1: string, ref2: string): Promise<Change[]>;

  /** Returns the repository's refs (branches, remote branches, tags). */
  getRefs(query?: RefQuery): Promise<Ref[]>;

  /** Checks out an existing branch or revision (`git checkout <treeish>`). */
  checkout(treeish: string): Promise<void>;

  /**
   * Creates a branch, optionally checking it out.
   *
   * @param ref Optional start point (e.g. a remote branch like `origin/main`).
   */
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
}

/** The Git extension API (version 1). */
export interface API {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
}

/** The shape exported by the `vscode.git` extension. */
export interface GitExtension {
  /**
   * Returns the Git API for the requested version.
   *
   * @param version API version. Only `1` is currently supported.
   */
  getAPI(version: 1): API;
}

export { Uri, Event, Disposable };

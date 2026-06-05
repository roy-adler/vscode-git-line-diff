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

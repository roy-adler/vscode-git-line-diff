/**
 * Helpers for paging git log results. The VS Code Git API's `skip` option is
 * not available on every host version; these helpers detect that and fall back
 * to re-fetching a larger window from HEAD.
 */

/** Parameters for the next `repository.log` call. */
export interface LogQuery {
  readonly maxEntries: number;
  readonly skip: number;
}

/** Result of merging a fetched page onto the commits already loaded. */
export interface PageMergeResult<T extends { readonly hash: string }> {
  readonly added: readonly T[];
  readonly commits: readonly T[];
  readonly hasMore: boolean;
  /** True when a skip>0 request returned commits we already have (skip ignored). */
  readonly skipIgnored: boolean;
}

/**
 * Computes the next log window.
 *
 * @param loadedCount Commits already in hand.
 * @param pageSize    Target page size.
 * @param skipSupported Whether the Git API honours `skip`.
 */
export function nextLogQuery(
  loadedCount: number,
  pageSize: number,
  skipSupported: boolean,
): LogQuery {
  if (skipSupported) {
    return { maxEntries: pageSize, skip: loadedCount };
  }
  return { maxEntries: loadedCount + pageSize, skip: 0 };
}

/**
 * Merges `page` onto `existing` (newest-first). Duplicate hashes are skipped.
 *
 * `skipRequested` should be true only when the fetch used `skip > 0`. If the
 * Git host ignored skip, the page repeats the already-loaded prefix (same first
 * hash) and {@link PageMergeResult.skipIgnored} is set so the caller can retry
 * without skip.
 */
export function mergeCommitPage<T extends { readonly hash: string }>(
  existing: readonly T[],
  page: readonly T[],
  pageSize: number,
  skipRequested: boolean,
): PageMergeResult<T> {
  const skipIgnored =
    skipRequested
    && existing.length > 0
    && page.length > 0
    && page[0].hash === existing[0].hash;

  if (skipIgnored) {
    return {
      added: [],
      commits: existing.slice(),
      hasMore: true,
      skipIgnored: true,
    };
  }

  const seen = new Set(existing.map((commit) => commit.hash));
  const added: T[] = [];
  for (const commit of page) {
    if (!seen.has(commit.hash)) {
      seen.add(commit.hash);
      added.push(commit);
    }
  }

  return {
    added,
    commits: existing.concat(added),
    hasMore: added.length > 0 && page.length >= pageSize,
    skipIgnored: false,
  };
}

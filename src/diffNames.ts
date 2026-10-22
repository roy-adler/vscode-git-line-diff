/**
 * Arguments for a name-only diff of one commit.
 *
 * Rename detection is disabled (`diff.renames=false`). On a large commit the
 * default rename search is quadratic and can block the graph's commit panel
 * indefinitely. A root commit (no `parentRef`) is diffed with `diff-tree
 * --root` so the empty tree works for both SHA-1 and SHA-256 repositories.
 */
export function commitNameStatusArgs(
  repoPath: string,
  commitRef: string,
  parentRef: string | undefined,
): string[] {
  const common = [
    '-C', repoPath,
    '-c', 'diff.renames=false',
  ];
  if (parentRef === undefined) {
    return [
      ...common,
      'diff-tree',
      '--root',
      '--no-commit-id',
      '-r',
      '--name-status',
      '--no-ext-diff',
      '--no-textconv',
      '-z',
      commitRef,
    ];
  }
  return [
    ...common,
    'diff',
    '--name-status',
    '--no-ext-diff',
    '--no-textconv',
    '-z',
    parentRef,
    commitRef,
  ];
}

/** A changed path parsed from `git diff --name-status -z`. */
export interface ParsedNameStatus {
  /** Path at the commit. For a rename this is the destination path. */
  readonly path: string;
  /** Path at the parent. Equals {@link path} when the file was not renamed. */
  readonly originalPath: string;
}

/**
 * Parses `git diff --name-status -z` / `git diff-tree --name-status -z` output.
 *
 * Records are NUL-separated. A rename or copy (`R*` / `C*`) is followed by the
 * old path and then the new path; every other status is followed by one path.
 */
export function parseNameStatusZ(text: string): ParsedNameStatus[] {
  const parts = text.split('\0');
  const entries: ParsedNameStatus[] = [];
  let index = 0;

  while (index < parts.length) {
    const status = parts[index];
    if (status === undefined || status.length === 0) {
      break;
    }
    index += 1;

    const renamed = status.startsWith('R') || status.startsWith('C');
    if (renamed) {
      const originalPath = parts[index];
      const path = parts[index + 1];
      index += 2;
      if (originalPath === undefined || originalPath.length === 0
        || path === undefined || path.length === 0) {
        break;
      }
      entries.push({ path, originalPath });
      continue;
    }

    const path = parts[index];
    index += 1;
    if (path === undefined || path.length === 0) {
      break;
    }
    entries.push({ path, originalPath: path });
  }

  return entries;
}

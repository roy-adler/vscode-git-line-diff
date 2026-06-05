/**
 * Commit-graph layout.
 *
 * Turns a list of commits (newest first, each with its parent hashes) into a
 * renderable model: every commit gets a column ("lane"), and every gap between
 * consecutive rows gets a set of line segments connecting lanes. The webview
 * draws nodes at `(column, row)` and paths for each segment.
 *
 * The algorithm walks commits top-to-bottom (newest -> oldest), maintaining the
 * set of "active lanes" — each lane remembers the next commit hash it expects.
 * This is the standard approach used by git graph renderers.
 */

/** Minimal commit shape required for layout. */
export interface GraphCommitInput {
  readonly hash: string;
  readonly parents: readonly string[];
}

/** A line segment in the gap directly above a row. */
export interface GraphLine {
  /** Column at the top of the gap (previous row's height). */
  readonly fromCol: number;
  /** Column at the bottom of the gap (this row's height). */
  readonly toCol: number;
  /** Palette colour index. */
  readonly color: number;
}

/** A laid-out commit row. */
export interface GraphRow {
  readonly hash: string;
  /** Column of the commit's node. */
  readonly col: number;
  /** Palette colour index for the node. */
  readonly color: number;
  /** Line segments connecting the previous row to this one. */
  readonly linesAbove: GraphLine[];
}

/** Full layout result. */
export interface GraphLayout {
  readonly rows: GraphRow[];
  /** Number of columns used by the widest part of the graph. */
  readonly columns: number;
}

/** Internal lane state: the commit a lane expects next, plus its top anchor. */
interface Lane {
  readonly hash: string;
  /**
   * Column to draw FROM in the next gap. Equals the lane's own column for
   * straight pass-through lines, or the creating commit's node column for the
   * first segment of a merge-parent edge (producing a diagonal from the node).
   */
  readonly originCol: number;
}

/** Assigns a stable-ish palette index to a column. */
function colorFor(column: number): number {
  return column % 8;
}

/**
 * Computes the graph layout for a list of commits (newest first).
 */
export function computeGraphLayout(commits: readonly GraphCommitInput[]): GraphLayout {
  // `lanes` is the state ENTERING the current row (lines coming from above).
  let lanes: (Lane | null)[] = [];
  const rows: GraphRow[] = [];
  let maxColumns = 0;

  for (const commit of commits) {
    // 1. Which existing lanes are waiting for this commit?
    const incoming: number[] = [];
    for (let c = 0; c < lanes.length; c++) {
      if (lanes[c]?.hash === commit.hash) {
        incoming.push(c);
      }
    }

    // 2. Node column: the first incoming lane, or a fresh lane for a branch tip.
    let nodeCol: number;
    if (incoming.length > 0) {
      nodeCol = incoming[0];
    } else {
      const free = lanes.indexOf(null);
      nodeCol = free === -1 ? lanes.length : free;
    }

    // 3. Lines for the gap above this row: every active incoming lane either
    //    bends into the node (its hash matches) or passes straight down.
    const linesAbove: GraphLine[] = [];
    for (let c = 0; c < lanes.length; c++) {
      const lane = lanes[c];
      if (lane === null) {
        continue;
      }
      const toCol = lane.hash === commit.hash ? nodeCol : c;
      linesAbove.push({ fromCol: lane.originCol, toCol, color: colorFor(toCol) });
    }

    rows.push({ hash: commit.hash, col: nodeCol, color: colorFor(nodeCol), linesAbove });

    // 4. Build the state LEAVING this row. Start from a vertical-default copy
    //    (each surviving lane anchored at its own column), then apply the node
    //    and its parents.
    const leaving: (Lane | null)[] = lanes.map((lane, c) =>
      lane === null ? null : { hash: lane.hash, originCol: c },
    );
    for (const c of incoming) {
      leaving[c] = null;
    }

    const parents = commit.parents;
    // First parent continues straight down in the node's lane.
    if (parents.length >= 1) {
      leaving[nodeCol] = { hash: parents[0], originCol: nodeCol };
    } else if (nodeCol < leaving.length) {
      leaving[nodeCol] = null;
    }
    if (nodeCol >= leaving.length) {
      // Fresh tip beyond current width: pad and place.
      while (leaving.length <= nodeCol) {
        leaving.push(null);
      }
      leaving[nodeCol] = parents.length >= 1 ? { hash: parents[0], originCol: nodeCol } : null;
    }

    // Additional parents (merges) branch out from the node column.
    for (let p = 1; p < parents.length; p++) {
      const parentHash = parents[p];
      const existing = leaving.findIndex((lane) => lane?.hash === parentHash);
      if (existing !== -1) {
        // Already tracked: draw this gap's segment diagonally from the node.
        leaving[existing] = { hash: parentHash, originCol: nodeCol };
      } else {
        const free = leaving.indexOf(null);
        const col = free === -1 ? leaving.length : free;
        if (col >= leaving.length) {
          leaving.push(null);
        }
        leaving[col] = { hash: parentHash, originCol: nodeCol };
      }
    }

    // Trim trailing empty lanes to keep the graph compact.
    while (leaving.length > 0 && leaving[leaving.length - 1] === null) {
      leaving.pop();
    }

    lanes = leaving;
    maxColumns = Math.max(maxColumns, lanes.length, nodeCol + 1);
  }

  return { rows, columns: maxColumns };
}

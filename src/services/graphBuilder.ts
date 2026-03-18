import { CommitInfo } from "./gitService";

// ── Interfaces ──────────────────────────────────────────────────────────

export interface GraphNode {
  hash: string;
  column: number;
  color: number;
  parents: { hash: string; column: number; color: number }[];
}

export interface GraphData {
  nodes: GraphNode[];
  maxColumns: number;
}

// ── Graph Builder ───────────────────────────────────────────────────────

/**
 * Builds a visual commit graph by assigning lane (column) positions
 * and colors to each commit. Handles merge commits, octopus merges,
 * and branch reuse when lanes become available.
 */
export function buildGraph(commits: CommitInfo[]): GraphData {
  const nodes: GraphNode[] = [];

  const lanes: (string | null)[] = [];
  let nextColor = 0;
  let maxColumns = 0;

  const colorMap = new Map<string, number>();
  const commitSet = new Set(commits.map((c) => c.hash));

  function allocateLane(hash: string): number {
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null) {
        lanes[i] = hash;
        return i;
      }
    }
    lanes.push(hash);
    return lanes.length - 1;
  }

  function assignColor(hash: string): number {
    const existing = colorMap.get(hash);
    if (existing !== undefined) {
      return existing;
    }
    const c = nextColor++;
    colorMap.set(hash, c);
    return c;
  }

  function trimTrailingNulls(): void {
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }
  }

  for (const commit of commits) {
    const occupiedIndices: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) {
        occupiedIndices.push(i);
      }
    }

    let column: number;
    let color: number;

    if (occupiedIndices.length > 0) {
      column = occupiedIndices[0];
      color = assignColor(commit.hash);

      for (let i = 1; i < occupiedIndices.length; i++) {
        lanes[occupiedIndices[i]] = null;
      }
    } else {
      column = allocateLane(commit.hash);
      color = assignColor(commit.hash);
    }

    // Remove this commit from the color map since it's been processed
    // (only keep entries that are still needed as future parent references)
    if (!commit.parents.some((p) => commitSet.has(p))) {
      colorMap.delete(commit.hash);
    }

    const parentEdges: { hash: string; column: number; color: number }[] = [];

    if (commit.parents.length === 0) {
      lanes[column] = null;
    } else {
      const firstParent = commit.parents[0];
      lanes[column] = firstParent;
      if (!colorMap.has(firstParent)) {
        colorMap.set(firstParent, color);
      }
      parentEdges.push({ hash: firstParent, column, color });

      for (let p = 1; p < commit.parents.length; p++) {
        const parentHash = commit.parents[p];

        let parentLane = lanes.indexOf(parentHash);
        if (parentLane === -1) {
          parentLane = allocateLane(parentHash);
        }

        const parentColor = assignColor(parentHash);
        parentEdges.push({
          hash: parentHash,
          column: parentLane,
          color: parentColor,
        });
      }
    }

    nodes.push({ hash: commit.hash, column, color, parents: parentEdges });

    trimTrailingNulls();

    const activeCount = lanes.filter((l) => l !== null).length;
    if (activeCount > maxColumns) {
      maxColumns = activeCount;
    }
  }

  // Ensure maxColumns is at least as wide as any assigned column
  for (const node of nodes) {
    if (node.column + 1 > maxColumns) {
      maxColumns = node.column + 1;
    }
    for (const pe of node.parents) {
      if (pe.column + 1 > maxColumns) {
        maxColumns = pe.column + 1;
      }
    }
  }

  return { nodes, maxColumns };
}

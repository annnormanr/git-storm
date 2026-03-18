import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";

const execFileAsync = promisify(execFile);
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

// ── Interfaces ──────────────────────────────────────────────────────────

export interface CommitInfo {
  hash: string;
  abbreviatedHash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: Date;
  committer: string;
  committerEmail: string;
  committerDate: Date;
  subject: string;
  body: string;
  refs: string[];
}

export interface FileChange {
  status: "A" | "M" | "D" | "R" | "C" | "U";
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
}

export interface BlameLine {
  hash: string;
  originalLine: number;
  finalLine: number;
  author: string;
  authorEmail: string;
  authorDate: Date;
  summary: string;
  content: string;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  lastCommitHash: string;
  lastCommitDate: Date;
  lastCommitMessage: string;
}

export interface StashEntry {
  index: number;
  message: string;
  date: Date;
  branch: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "context" | "add" | "delete";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  status: string;
  hunks: DiffHunk[];
  isBinary: boolean;
}

export interface MergeConflict {
  path: string;
  ours: string;
  theirs: string;
  base: string;
}

export interface LogFilter {
  branch?: string;
  author?: string;
  since?: string;
  until?: string;
  path?: string;
  search?: string;
  maxCount?: number;
  skip?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

const LOG_FORMAT = [
  "%H",
  "%h",
  "%P",
  "%an",
  "%ae",
  "%aI",
  "%cn",
  "%ce",
  "%cI",
  "%s",
  "%b",
  "%D",
].join(FIELD_SEP);

function parseCommitRecord(record: string): CommitInfo | null {
  const fields = record.split(FIELD_SEP);
  if (fields.length < 12) {
    return null;
  }

  // Body (field 10) may contain FIELD_SEP chars producing extra fields.
  // Refs is always the last field; body is everything between field 10 and last.
  const refs = fields[fields.length - 1];
  const body = fields
    .slice(10, fields.length - 1)
    .join(FIELD_SEP)
    .trim();

  return {
    hash: fields[0],
    abbreviatedHash: fields[1],
    parents: fields[2] ? fields[2].split(" ") : [],
    author: fields[3],
    authorEmail: fields[4],
    authorDate: new Date(fields[5]),
    committer: fields[6],
    committerEmail: fields[7],
    committerDate: new Date(fields[8]),
    subject: fields[9],
    body,
    refs: refs
      ? refs
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean)
      : [],
  };
}

export function parseDiffOutput(raw: string): FileDiff[] {
  const diffs: FileDiff[] = [];
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");
    const headerMatch = lines[0].match(/^a\/(.+?) b\/(.+)$/);
    if (!headerMatch) {
      continue;
    }

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];

    const isBinary = lines.some((l) => l.startsWith("Binary files"));
    if (isBinary) {
      diffs.push({ oldPath, newPath, status: "M", hunks: [], isBinary: true });
      continue;
    }

    let status = "M";
    for (const line of lines) {
      if (line.startsWith("new file")) {
        status = "A";
        break;
      }
      if (line.startsWith("deleted file")) {
        status = "D";
        break;
      }
      if (line.startsWith("rename from")) {
        status = "R";
        break;
      }
      if (line.startsWith("copy from")) {
        status = "C";
        break;
      }
    }

    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      const hunkMatch = line.match(
        /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)/,
      );
      if (hunkMatch) {
        currentHunk = {
          oldStart: parseInt(hunkMatch[1], 10),
          oldLines: parseInt(hunkMatch[2] ?? "1", 10),
          newStart: parseInt(hunkMatch[3], 10),
          newLines: parseInt(hunkMatch[4] ?? "1", 10),
          header: hunkMatch[5]?.trim() ?? "",
          lines: [],
        };
        hunks.push(currentHunk);
        oldLine = currentHunk.oldStart;
        newLine = currentHunk.newStart;
        continue;
      }

      if (!currentHunk) {
        continue;
      }

      if (line.startsWith("+")) {
        currentHunk.lines.push({
          type: "add",
          content: line.substring(1),
          newLineNumber: newLine,
        });
        newLine++;
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({
          type: "delete",
          content: line.substring(1),
          oldLineNumber: oldLine,
        });
        oldLine++;
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({
          type: "context",
          content: line.substring(1),
          oldLineNumber: oldLine,
          newLineNumber: newLine,
        });
        oldLine++;
        newLine++;
      }
    }

    diffs.push({ oldPath, newPath, status, hunks, isBinary: false });
  }

  return diffs;
}

function parseStatusCode(code: string): FileChange["status"] {
  const c = code.charAt(0);
  switch (c) {
    case "A":
      return "A";
    case "D":
      return "D";
    case "R":
      return "R";
    case "C":
      return "C";
    case "U":
      return "U";
    default:
      return "M";
  }
}

// ── Git Service ─────────────────────────────────────────────────────────

export class GitService {
  private repoRoot: string | undefined;

  constructor(private workspaceRoot: string) {}

  private async git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
      cwd: cwd ?? this.workspaceRoot,
      maxBuffer: 100 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  }

  private async gitWithStderr(
    args: string[],
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync("git", ["--no-pager", ...args], {
      cwd: cwd ?? this.workspaceRoot,
      maxBuffer: 100 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }

  // ── Repository ──────────────────────────────────────────────────────

  async getRepoRoot(): Promise<string> {
    if (this.repoRoot) {
      return this.repoRoot;
    }
    const root = (await this.git(["rev-parse", "--show-toplevel"])).trim();
    this.repoRoot = root;
    return root;
  }

  // ── Log & History ───────────────────────────────────────────────────

  async getLog(filter?: LogFilter): Promise<CommitInfo[]> {
    const args = ["log", `--format=${RECORD_SEP}${LOG_FORMAT}`];

    if (filter?.maxCount) {
      args.push(`--max-count=${filter.maxCount}`);
    }
    if (filter?.skip) {
      args.push(`--skip=${filter.skip}`);
    }
    if (filter?.author) {
      args.push(`--author=${filter.author}`);
    }
    if (filter?.since) {
      args.push(`--since=${filter.since}`);
    }
    if (filter?.until) {
      args.push(`--until=${filter.until}`);
    }
    if (filter?.search) {
      args.push(`--grep=${filter.search}`);
    }
    if (filter?.branch) {
      args.push(filter.branch);
    }

    if (filter?.path) {
      args.push("--");
      args.push(filter.path);
    }

    const output = await this.git(args);
    const records = output.split(RECORD_SEP).filter((r) => r.trim());
    const commits: CommitInfo[] = [];

    for (const rec of records) {
      const commit = parseCommitRecord(rec.trim());
      if (commit) {
        commits.push(commit);
      }
    }

    return commits;
  }

  async getCommitDetails(
    hash: string,
  ): Promise<{ commit: CommitInfo; files: FileChange[] }> {
    const logOutput = await this.git([
      "log",
      "-1",
      `--format=${RECORD_SEP}${LOG_FORMAT}`,
      hash,
    ]);
    const commit = parseCommitRecord(
      logOutput.split(RECORD_SEP).filter(Boolean)[0]?.trim() ?? "",
    );
    if (!commit) {
      throw new Error(`Could not parse commit ${hash}`);
    }

    const isRoot = commit && commit.parents.length === 0;
    const diffTreeBaseArgs = ["diff-tree", "--no-commit-id", "-r"];
    if (isRoot) {
      diffTreeBaseArgs.push("--root");
    }

    const numstatOutput = await this.git([
      ...diffTreeBaseArgs,
      "--numstat",
      "-M",
      "-C",
      hash,
    ]);
    const nameStatusOutput = await this.git([
      ...diffTreeBaseArgs,
      "--name-status",
      "-M",
      "-C",
      hash,
    ]);

    const nameStatusLines = nameStatusOutput.trim().split("\n").filter(Boolean);
    const numstatLines = numstatOutput.trim().split("\n").filter(Boolean);

    const files: FileChange[] = [];
    for (let i = 0; i < nameStatusLines.length; i++) {
      const nsParts = nameStatusLines[i].split("\t");
      const statusCode = nsParts[0];
      const status = parseStatusCode(statusCode);

      let filePath: string;
      let oldPath: string | undefined;
      if (status === "R" || status === "C") {
        oldPath = nsParts[1];
        filePath = nsParts[2];
      } else {
        filePath = nsParts[1];
      }

      let additions = 0;
      let deletions = 0;
      if (i < numstatLines.length) {
        const numParts = numstatLines[i].split("\t");
        additions = numParts[0] === "-" ? 0 : parseInt(numParts[0], 10);
        deletions = numParts[1] === "-" ? 0 : parseInt(numParts[1], 10);
      }

      files.push({ status, path: filePath, oldPath, additions, deletions });
    }

    return { commit, files };
  }

  async getFileHistory(
    filePath: string,
    maxCount?: number,
  ): Promise<CommitInfo[]> {
    const args = ["log", `--format=${RECORD_SEP}${LOG_FORMAT}`, "--follow"];
    if (maxCount) {
      args.push(`--max-count=${maxCount}`);
    }
    args.push("--", filePath);

    const output = await this.git(args);
    const records = output.split(RECORD_SEP).filter((r) => r.trim());
    const commits: CommitInfo[] = [];

    for (const rec of records) {
      const commit = parseCommitRecord(rec.trim());
      if (commit) {
        commits.push(commit);
      }
    }

    return commits;
  }

  // ── Blame ───────────────────────────────────────────────────────────

  async getBlame(filePath: string): Promise<BlameLine[]> {
    const output = await this.git(["blame", "--porcelain", filePath]);
    const lines = output.split("\n");
    const result: BlameLine[] = [];
    let current: Partial<BlameLine> = {};
    let expectContent = false;

    for (const line of lines) {
      if (expectContent) {
        current.content = line.startsWith("\t") ? line.substring(1) : line;
        result.push(current as BlameLine);
        current = {};
        expectContent = false;
        continue;
      }

      const headerMatch = line.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
      if (headerMatch) {
        current.hash = headerMatch[1];
        current.originalLine = parseInt(headerMatch[2], 10);
        current.finalLine = parseInt(headerMatch[3], 10);
        continue;
      }

      if (line.startsWith("author ")) {
        current.author = line.substring(7);
      } else if (line.startsWith("author-mail ")) {
        current.authorEmail = line.substring(12).replace(/[<>]/g, "");
      } else if (line.startsWith("author-time ")) {
        current.authorDate = new Date(parseInt(line.substring(12), 10) * 1000);
      } else if (line.startsWith("summary ")) {
        current.summary = line.substring(8);
      } else if (line.startsWith("filename ")) {
        expectContent = true;
      }
    }

    return result;
  }

  // ── Branches ────────────────────────────────────────────────────────

  async getBranches(): Promise<BranchInfo[]> {
    const format = [
      "%(refname:short)",
      "%(HEAD)",
      "%(objectname:short)",
      "%(committerdate:iso)",
      "%(subject)",
      "%(upstream:short)",
      "%(upstream:track)",
    ].join(FIELD_SEP);

    const localOutput = await this.git([
      "for-each-ref",
      `--format=${format}`,
      "refs/heads/",
    ]);
    const remoteOutput = await this.git([
      "for-each-ref",
      `--format=${format}`,
      "refs/remotes/",
    ]);

    const branches: BranchInfo[] = [];

    const parseLine = (line: string, isRemote: boolean): BranchInfo | null => {
      const fields = line.split(FIELD_SEP);
      if (fields.length < 7) {
        return null;
      }

      const trackInfo = fields[6];
      let ahead = 0;
      let behind = 0;
      const aheadMatch = trackInfo.match(/ahead (\d+)/);
      const behindMatch = trackInfo.match(/behind (\d+)/);
      if (aheadMatch) {
        ahead = parseInt(aheadMatch[1], 10);
      }
      if (behindMatch) {
        behind = parseInt(behindMatch[1], 10);
      }

      return {
        name: fields[0],
        current: fields[1] === "*",
        remote: isRemote,
        upstream: fields[5] || undefined,
        ahead,
        behind,
        lastCommitHash: fields[2],
        lastCommitDate: new Date(fields[3]),
        lastCommitMessage: fields[4],
      };
    };

    for (const line of localOutput.trim().split("\n").filter(Boolean)) {
      const b = parseLine(line, false);
      if (b) {
        branches.push(b);
      }
    }
    for (const line of remoteOutput.trim().split("\n").filter(Boolean)) {
      const b = parseLine(line, true);
      if (b) {
        branches.push(b);
      }
    }

    return branches;
  }

  async getCurrentBranch(): Promise<string> {
    return (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    const args = ["checkout", "-b", name];
    if (startPoint) {
      args.push(startPoint);
    }
    await this.git(args);
  }

  async checkoutBranch(name: string): Promise<void> {
    await this.git(["checkout", name]);
  }

  async deleteBranch(name: string, force?: boolean): Promise<void> {
    await this.git(["branch", force ? "-D" : "-d", name]);
  }

  async mergeBranch(name: string, noFf?: boolean): Promise<string> {
    const args = ["merge", name];
    if (noFf) {
      args.push("--no-ff");
    }
    const { stdout, stderr } = await this.gitWithStderr(args);
    return stdout + stderr;
  }

  async rebaseBranch(onto: string): Promise<string> {
    const { stdout, stderr } = await this.gitWithStderr(["rebase", onto]);
    return stdout + stderr;
  }

  // ── Working Tree ────────────────────────────────────────────────────

  async getStatus(): Promise<FileChange[]> {
    const output = await this.git(["status", "--porcelain=v2", "-z"]);
    const entries = output.split("\0").filter(Boolean);
    const changes: FileChange[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      if (entry.startsWith("1 ") || entry.startsWith("2 ")) {
        const parts = entry.split(" ");

        if (entry.startsWith("2 ")) {
          // rename / copy: 2 XY sub mH mI mW hH hI Xscore path\0origPath\0
          const xy = parts[1];
          const status =
            xy.charAt(0) === "R" || xy.charAt(1) === "R"
              ? ("R" as const)
              : ("C" as const);
          const filePath = parts.slice(9).join(" ");
          const oldPath = entries[++i];
          changes.push({
            status,
            path: filePath,
            oldPath,
            additions: 0,
            deletions: 0,
          });
        } else {
          const xy = parts[1];
          let status: FileChange["status"] = "M";
          if (xy.includes("A") || xy.includes("?")) {
            status = "A";
          } else if (xy.includes("D")) {
            status = "D";
          } else if (xy.includes("U")) {
            status = "U";
          }

          const filePath = parts.slice(8).join(" ");
          changes.push({ status, path: filePath, additions: 0, deletions: 0 });
        }
      } else if (entry.startsWith("u ")) {
        const parts = entry.split(" ");
        const filePath = parts.slice(10).join(" ");
        changes.push({
          status: "U",
          path: filePath,
          additions: 0,
          deletions: 0,
        });
      } else if (entry.startsWith("? ")) {
        const filePath = entry.substring(2);
        changes.push({
          status: "A",
          path: filePath,
          additions: 0,
          deletions: 0,
        });
      }
    }

    return changes;
  }

  async stageFile(filePath: string): Promise<void> {
    await this.git(["add", "--", filePath]);
  }

  async unstageFile(filePath: string): Promise<void> {
    await this.git(["reset", "HEAD", "--", filePath]);
  }

  async stageLines(filePath: string, patch: string): Promise<void> {
    const repoRoot = await this.getRepoRoot();
    const tmpFile = path.join(repoRoot, ".git", "gitstorm-patch.tmp");
    await writeFileAsync(tmpFile, patch);
    try {
      await this.git(["apply", "--cached", "--", tmpFile]);
    } finally {
      fs.unlink(tmpFile, () => {});
    }
  }

  async applyPatchToWorkingTree(patch: string): Promise<void> {
    const repoRoot = await this.getRepoRoot();
    const tmpFile = path.join(repoRoot, ".git", "gitstorm-patch-wt.tmp");
    await writeFileAsync(tmpFile, patch);
    try {
      await this.git(["apply", "--", tmpFile]);
    } finally {
      fs.unlink(tmpFile, () => {});
    }
  }

  // ── Diff ────────────────────────────────────────────────────────────

  async getDiff(filePath?: string, staged?: boolean): Promise<FileDiff[]> {
    const args = ["diff"];
    if (staged) {
      args.push("--cached");
    }
    if (filePath) {
      args.push("--", filePath);
    }
    const output = await this.git(args);
    return parseDiffOutput(output);
  }

  async getDiffBetween(
    ref1: string,
    ref2: string,
    filePath?: string,
  ): Promise<FileDiff[]> {
    const args = ["diff", ref1, ref2];
    if (filePath) {
      args.push("--", filePath);
    }
    const output = await this.git(args);
    return parseDiffOutput(output);
  }

  async getCommitDiff(hash: string, filePath?: string): Promise<FileDiff[]> {
    const args = [
      "diff-tree",
      "-p",
      "--root",
      "-M",
      "-C",
      "--no-commit-id",
      hash,
    ];
    if (filePath) {
      args.push("--", filePath);
    }
    const output = await this.git(args);
    return parseDiffOutput(output);
  }

  // ── Stash ───────────────────────────────────────────────────────────

  async getStashes(): Promise<StashEntry[]> {
    let output: string;
    try {
      output = await this.git([
        "stash",
        "list",
        `--format=%gd${FIELD_SEP}%s${FIELD_SEP}%cI`,
      ]);
    } catch {
      return [];
    }

    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(FIELD_SEP);
        const indexMatch = parts[0].match(/\{(\d+)\}/);
        const branchMatch = parts[1]?.match(/^WIP on (.+?):|^On (.+?):/);
        return {
          index: indexMatch ? parseInt(indexMatch[1], 10) : 0,
          message: parts[1] ?? "",
          date: new Date(parts[2] ?? ""),
          branch: branchMatch ? (branchMatch[1] ?? branchMatch[2] ?? "") : "",
        };
      });
  }

  async getStashFiles(index: number): Promise<FileChange[]> {
    const stashRef = `stash@{${index}}`;

    // Run two separate commands because passing both flags in one call
    // causes git to only honor the last format flag.
    const [numstatOutput, nameStatusOutput] = await Promise.all([
      this.git(["stash", "show", "--numstat", stashRef]).catch(() => ""),
      this.git(["stash", "show", "--name-status", stashRef]).catch(() => ""),
    ]);

    const numstatLines = numstatOutput.trim().split("\n").filter(Boolean);
    const nameStatusLines = nameStatusOutput.trim().split("\n").filter(Boolean);

    if (nameStatusLines.length === 0 && numstatLines.length > 0) {
      return numstatLines.map((line) => {
        const parts = line.split("\t");
        const additions = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
        const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
        let filePath = parts[2];
        const renameMatch = filePath.match(/^(.*)\{.+ => (.+)\}(.*)$/);
        if (renameMatch) {
          filePath = renameMatch[1] + renameMatch[2] + renameMatch[3];
        }
        return { status: "M" as const, path: filePath, additions, deletions };
      });
    }

    const files: FileChange[] = [];
    for (let i = 0; i < nameStatusLines.length; i++) {
      const nsParts = nameStatusLines[i].split("\t");
      const status = parseStatusCode(nsParts[0]);
      const filePath =
        status === "R" || status === "C" ? nsParts[2] : nsParts[1];
      const oldPath = status === "R" || status === "C" ? nsParts[1] : undefined;

      let additions = 0;
      let deletions = 0;
      if (i < numstatLines.length) {
        const numParts = numstatLines[i].split("\t");
        additions = numParts[0] === "-" ? 0 : parseInt(numParts[0], 10);
        deletions = numParts[1] === "-" ? 0 : parseInt(numParts[1], 10);
      }

      files.push({ status, path: filePath, oldPath, additions, deletions });
    }

    return files;
  }

  async stash(message?: string, includeUntracked?: boolean): Promise<void> {
    const args = ["stash", "push"];
    if (message) {
      args.push("-m", message);
    }
    if (includeUntracked) {
      args.push("--include-untracked");
    }
    await this.git(args);
  }

  async stashPop(index?: number): Promise<void> {
    const args = ["stash", "pop"];
    if (index !== undefined) {
      args.push(`stash@{${index}}`);
    }
    await this.git(args);
  }

  async stashApply(index?: number): Promise<void> {
    const args = ["stash", "apply"];
    if (index !== undefined) {
      args.push(`stash@{${index}}`);
    }
    await this.git(args);
  }

  async stashDrop(index?: number): Promise<void> {
    const args = ["stash", "drop"];
    if (index !== undefined) {
      args.push(`stash@{${index}}`);
    }
    await this.git(args);
  }

  // ── Cherry-pick / Revert / Reset ───────────────────────────────────

  async cherryPick(hash: string): Promise<string> {
    const { stdout, stderr } = await this.gitWithStderr(["cherry-pick", hash]);
    return stdout + stderr;
  }

  async revertCommit(hash: string): Promise<string> {
    const { stdout, stderr } = await this.gitWithStderr([
      "revert",
      "--no-edit",
      hash,
    ]);
    return stdout + stderr;
  }

  async resetToCommit(
    hash: string,
    mode: "soft" | "mixed" | "hard",
  ): Promise<void> {
    await this.git(["reset", `--${mode}`, hash]);
  }

  // ── Tags ────────────────────────────────────────────────────────────

  async createTag(
    name: string,
    hash?: string,
    message?: string,
  ): Promise<void> {
    const args = ["tag"];
    if (message) {
      args.push("-a", name, "-m", message);
    } else {
      args.push(name);
    }
    if (hash) {
      args.push(hash);
    }
    await this.git(args);
  }

  // ── Merge Conflicts ────────────────────────────────────────────────

  async getMergeConflicts(): Promise<MergeConflict[]> {
    let output: string;
    try {
      output = await this.git(["diff", "--name-only", "--diff-filter=U"]);
    } catch {
      return [];
    }

    const conflictPaths = output.trim().split("\n").filter(Boolean);
    const repoRoot = await this.getRepoRoot();
    const conflicts: MergeConflict[] = [];

    for (const p of conflictPaths) {
      const fullPath = path.join(repoRoot, p);
      let content: string;
      try {
        content = await readFileAsync(fullPath, "utf-8");
      } catch {
        continue;
      }

      let ours = "";
      let theirs = "";
      let base = "";
      let section: "none" | "ours" | "base" | "theirs" = "none";

      for (const line of content.split("\n")) {
        if (line.startsWith("<<<<<<<")) {
          section = "ours";
        } else if (line.startsWith("|||||||")) {
          section = "base";
        } else if (line.startsWith("=======")) {
          section = "theirs";
        } else if (line.startsWith(">>>>>>>")) {
          section = "none";
        } else {
          switch (section) {
            case "ours":
              ours += line + "\n";
              break;
            case "theirs":
              theirs += line + "\n";
              break;
            case "base":
              base += line + "\n";
              break;
          }
        }
      }

      conflicts.push({ path: p, ours, theirs, base });
    }

    return conflicts;
  }

  async resolveConflict(
    filePath: string,
    resolution: "ours" | "theirs" | "merged",
    content?: string,
  ): Promise<void> {
    if (resolution === "merged" && content !== undefined) {
      const repoRoot = await this.getRepoRoot();
      await writeFileAsync(path.join(repoRoot, filePath), content);
    } else if (resolution === "ours") {
      await this.git(["checkout", "--ours", "--", filePath]);
    } else if (resolution === "theirs") {
      await this.git(["checkout", "--theirs", "--", filePath]);
    }
    await this.git(["add", "--", filePath]);
  }

  async abortMerge(): Promise<void> {
    await this.git(["merge", "--abort"]);
  }

  async continueMerge(): Promise<void> {
    await this.git(["merge", "--continue"]);
  }

  // ── Rebase ──────────────────────────────────────────────────────────

  async abortRebase(): Promise<void> {
    await this.git(["rebase", "--abort"]);
  }

  async continueRebase(): Promise<void> {
    await this.git(["rebase", "--continue"]);
  }

  async getRebaseStatus(): Promise<{
    inProgress: boolean;
    currentStep?: number;
    totalSteps?: number;
    currentCommit?: string;
  }> {
    const repoRoot = await this.getRepoRoot();
    const rebaseMergePath = path.join(repoRoot, ".git", "rebase-merge");
    const rebaseApplyPath = path.join(repoRoot, ".git", "rebase-apply");

    let activePath: string | null = null;
    try {
      fs.accessSync(rebaseMergePath);
      activePath = rebaseMergePath;
    } catch {
      /* noop */
    }
    if (!activePath) {
      try {
        fs.accessSync(rebaseApplyPath);
        activePath = rebaseApplyPath;
      } catch {
        /* noop */
      }
    }

    if (!activePath) {
      return { inProgress: false };
    }

    let currentStep: number | undefined;
    let totalSteps: number | undefined;
    let currentCommit: string | undefined;

    try {
      const msgnum = (
        await readFileAsync(path.join(activePath, "msgnum"), "utf-8")
      ).trim();
      currentStep = parseInt(msgnum, 10);
    } catch {
      /* noop */
    }

    try {
      const end = (
        await readFileAsync(path.join(activePath, "end"), "utf-8")
      ).trim();
      totalSteps = parseInt(end, 10);
    } catch {
      /* noop */
    }

    try {
      const stopped = (
        await readFileAsync(path.join(activePath, "stopped-sha"), "utf-8")
      ).trim();
      currentCommit = stopped;
    } catch {
      try {
        currentCommit = (
          await readFileAsync(path.join(activePath, "current-commit"), "utf-8")
        ).trim();
      } catch {
        /* noop */
      }
    }

    return { inProgress: true, currentStep, totalSteps, currentCommit };
  }

  // ── Remotes ─────────────────────────────────────────────────────────

  async getRemotes(): Promise<
    { name: string; fetchUrl: string; pushUrl: string }[]
  > {
    const output = await this.git(["remote", "-v"]);
    const map = new Map<
      string,
      { name: string; fetchUrl: string; pushUrl: string }
    >();

    for (const line of output.trim().split("\n").filter(Boolean)) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match) {
        continue;
      }
      const [, name, url, kind] = match;
      if (!map.has(name)) {
        map.set(name, { name, fetchUrl: "", pushUrl: "" });
      }
      const entry = map.get(name)!;
      if (kind === "fetch") {
        entry.fetchUrl = url;
      } else {
        entry.pushUrl = url;
      }
    }

    return [...map.values()];
  }

  async fetch(remote?: string): Promise<void> {
    const args = ["fetch"];
    if (remote) {
      args.push(remote);
    } else {
      args.push("--all");
    }
    await this.git(args);
  }

  async pull(
    remote?: string,
    branch?: string,
    rebase?: boolean,
  ): Promise<string> {
    const args = ["pull"];
    if (rebase) {
      args.push("--rebase");
    }
    if (remote) {
      args.push(remote);
      if (branch) {
        args.push(branch);
      }
    }
    const { stdout, stderr } = await this.gitWithStderr(args);
    return stdout + stderr;
  }

  async push(
    remote?: string,
    branch?: string,
    force?: boolean,
  ): Promise<string> {
    const args = ["push"];
    if (force) {
      args.push("--force-with-lease");
    }
    if (remote) {
      args.push(remote);
      if (branch) {
        args.push(branch);
      }
    }
    const { stdout, stderr } = await this.gitWithStderr(args);
    return stdout + stderr;
  }
}

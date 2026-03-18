import * as https from "https";
import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ── Interfaces ──────────────────────────────────────────────────────────

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  author: string;
  createdAt: Date;
  updatedAt: Date;
  headBranch: string;
  baseBranch: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewers: string[];
  labels: string[];
  url: string;
  mergeable: boolean;
  draft: boolean;
}

export interface PRComment {
  id: number;
  author: string;
  body: string;
  createdAt: Date;
  path?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  inReplyTo?: number;
}

export interface PRReview {
  id: number;
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
  body: string;
  submittedAt: Date;
  comments: PRComment[];
}

// ── HTTP Helpers ────────────────────────────────────────────────────────

interface ApiResponse<T = unknown> {
  data: T;
  headers: Record<string, string | string[] | undefined>;
  statusCode: number;
}

function request<T = unknown>(
  method: string,
  urlPath: string,
  token: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: "api.github.com",
      path: urlPath,
      method,
      headers: {
        "User-Agent": "GitStorm-VSCode",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {}),
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const statusCode = res.statusCode ?? 0;
        const headers = res.headers as Record<
          string,
          string | string[] | undefined
        >;

        if (statusCode === 403 && headers["x-ratelimit-remaining"] === "0") {
          const resetTime = parseInt(
            String(headers["x-ratelimit-reset"] ?? "0"),
            10,
          );
          const waitSec = Math.max(
            0,
            resetTime - Math.floor(Date.now() / 1000),
          );
          reject(
            new Error(`GitHub rate limit exceeded. Resets in ${waitSec}s.`),
          );
          return;
        }

        if (statusCode >= 400) {
          let message = `GitHub API error ${statusCode}`;
          try {
            message =
              (JSON.parse(raw) as { message?: string }).message ?? message;
          } catch {
            /* noop */
          }
          reject(new Error(message));
          return;
        }

        let data: T;
        try {
          data = raw ? (JSON.parse(raw) as T) : (undefined as unknown as T);
        } catch {
          reject(new Error("Failed to parse GitHub API response"));
          return;
        }

        resolve({ data, headers, statusCode });
      });
    });

    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error("GitHub API request timed out after 30 seconds"));
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function paginatedGet<T>(urlPath: string, token: string): Promise<T[]> {
  const results: T[] = [];
  let nextPath: string | null = urlPath;

  while (nextPath) {
    const currentPath: string = nextPath;
    const separator = currentPath.includes("?") ? "&" : "?";
    const fullPath: string = currentPath.includes("per_page")
      ? currentPath
      : `${currentPath}${separator}per_page=100`;
    const res: ApiResponse<T[]> = await request<T[]>("GET", fullPath, token);
    if (res.data) {
      results.push(...res.data);
    }

    const linkHeader: string | string[] | undefined = res.headers["link"];
    nextPath = null;
    if (typeof linkHeader === "string") {
      const nextMatch: RegExpMatchArray | null = linkHeader.match(
        /<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/,
      );
      if (nextMatch) {
        nextPath = nextMatch[1];
      }
    }
  }

  return results;
}

// ── GitHub Service ──────────────────────────────────────────────────────

export class GitHubService {
  private token: string | undefined;

  constructor(private workspaceRoot: string) {}

  async getToken(): Promise<string> {
    if (this.token) {
      return this.token;
    }

    // 1. Check VS Code settings
    const configToken = vscode.workspace
      .getConfiguration("gitstorm")
      .get<string>("github.token");
    if (configToken) {
      this.token = configToken;
      return configToken;
    }

    // 2. Try `gh auth token`
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"], {
        cwd: this.workspaceRoot,
        timeout: 5000,
      });
      const ghToken = stdout.trim();
      if (ghToken) {
        this.token = ghToken;
        return ghToken;
      }
    } catch {
      /* gh CLI not available or not authenticated */
    }

    throw new Error("GitHub token not configured");
  }

  async getTokenSilent(): Promise<string | null> {
    try {
      return await this.getToken();
    } catch {
      return null;
    }
  }

  async promptForToken(): Promise<string> {
    const input = await vscode.window.showInputBox({
      prompt: "Enter your GitHub personal access token",
      password: true,
      ignoreFocusOut: true,
    });

    if (!input) {
      throw new Error("GitHub token is required");
    }
    this.token = input;
    return input;
  }

  clearToken(): void {
    this.token = undefined;
  }

  async getRepoInfo(): Promise<{ owner: string; repo: string }> {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-pager", "remote", "get-url", "origin"],
      {
        cwd: this.workspaceRoot,
      },
    );
    const url = stdout.trim();

    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    throw new Error(
      `Could not parse GitHub owner/repo from remote URL: ${url}`,
    );
  }

  // ── Pull Requests ───────────────────────────────────────────────────

  async listPullRequests(
    state: "open" | "closed" | "all" = "open",
  ): Promise<PullRequest[]> {
    const token = await this.getToken();
    const { owner, repo } = await this.getRepoInfo();
    const items = await paginatedGet<GHPullRequest>(
      `/repos/${owner}/${repo}/pulls?state=${state}`,
      token,
    );
    return items.map(mapPR);
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const token = await this.getToken();
    const { owner, repo } = await this.getRepoInfo();
    const { data } = await request<GHPullRequest>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}`,
      token,
    );
    return mapPR(data);
  }

  async createPullRequest(
    title: string,
    body: string,
    head: string,
    base: string,
    draft?: boolean,
  ): Promise<PullRequest> {
    const token = await this.getToken();
    const { owner, repo } = await this.getRepoInfo();
    const { data } = await request<GHPullRequest>(
      "POST",
      `/repos/${owner}/${repo}/pulls`,
      token,
      { title, body, head, base, draft: draft ?? false },
    );
    return mapPR(data);
  }

  // ── Comments ────────────────────────────────────────────────────────

  async getPRComments(prNumber: number): Promise<PRComment[]> {
    const token = await this.getToken();
    const { owner, repo } = await this.getRepoInfo();

    const issueComments = await paginatedGet<GHComment>(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      token,
    );
    const reviewComments = await paginatedGet<GHReviewComment>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      token,
    );

    const mapped: PRComment[] = [
      ...issueComments.map((c) => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        createdAt: new Date(c.created_at),
      })),
      ...reviewComments.map((c) => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        createdAt: new Date(c.created_at),
        path: c.path,
        line: c.line ?? c.original_line ?? undefined,
        side: c.side as "LEFT" | "RIGHT" | undefined,
        inReplyTo: c.in_reply_to_id,
      })),
    ];

    mapped.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return mapped;
  }

  async addPRComment(
    prNumber: number,
    body: string,
    path?: string,
    line?: number,
    side?: string,
  ): Promise<PRComment> {
    const token = await this.getToken();
    const { owner, repo } = await this.getRepoInfo();

    if (path && line) {
      // Review comment (on a specific line of a file)
      const { data: pr } = await request<GHPullRequest>(
        "GET",
        `/repos/${owner}/${repo}/pulls/${prNumber}`,
        token,
      );
      const commitId = pr.head?.sha;

      const payload: Record<string, unknown> = {
        body,
        path,
        line,
        commit_id: commitId,
      };
      if (side) {
        payload.side = side;
      }

      const { data } = await request<GHReviewComment>(
        "POST",
        `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        token,
        payload,
      );
      return {
        id: data.id,
        author: data.user?.login ?? "unknown",
        body: data.body ?? "",
        createdAt: new Date(data.created_at),
        path: data.path,
        line: data.line ?? data.original_line ?? undefined,
        side: data.side as "LEFT" | "RIGHT" | undefined,
      };
    } else {
      // Issue comment (general)
      const { data } = await request<GHComment>(
        "POST",
        `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        token,
        { body },
      );
      return {
        id: data.id,
        author: data.user?.login ?? "unknown",
        body: data.body ?? "",
        createdAt: new Date(data.created_at),
      };
    }
  }

  // ── Reviews ─────────────────────────────────────────────────────────

  async getPRReviews(prNumber: number): Promise<PRReview[]> {
    const token = await this.getToken();
    const { owner, repo } = await this.getRepoInfo();

    const rawReviews = await paginatedGet<GHReview>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      token,
    );

    const reviews: PRReview[] = [];
    for (const r of rawReviews) {
      const reviewComments = await paginatedGet<GHReviewComment>(
        `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${r.id}/comments`,
        token,
      );

      reviews.push({
        id: r.id,
        author: r.user?.login ?? "unknown",
        state: r.state as PRReview["state"],
        body: r.body ?? "",
        submittedAt: new Date(r.submitted_at),
        comments: reviewComments.map((c) => ({
          id: c.id,
          author: c.user?.login ?? "unknown",
          body: c.body ?? "",
          createdAt: new Date(c.created_at),
          path: c.path,
          line: c.line ?? c.original_line ?? undefined,
          side: c.side as "LEFT" | "RIGHT" | undefined,
          inReplyTo: c.in_reply_to_id,
        })),
      });
    }

    return reviews;
  }

  async submitReview(
    prNumber: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string,
  ): Promise<void> {
    const token = await this.getToken();
    const { owner, repo } = await this.getRepoInfo();
    await request(
      "POST",
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      token,
      { event, body: body ?? "" },
    );
  }

  // ── Merge ───────────────────────────────────────────────────────────

  async mergePullRequest(
    prNumber: number,
    method: "merge" | "squash" | "rebase" = "merge",
  ): Promise<void> {
    const token = await this.getToken();
    const { owner, repo } = await this.getRepoInfo();
    await request(
      "PUT",
      `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
      token,
      { merge_method: method },
    );
  }

  // ── Gists ───────────────────────────────────────────────────────────

  async createGist(
    description: string,
    files: { [filename: string]: string },
    isPublic: boolean = false,
  ): Promise<string> {
    const token = await this.getToken();
    const gistFiles: Record<string, { content: string }> = {};
    for (const [name, content] of Object.entries(files)) {
      gistFiles[name] = { content };
    }
    const { data } = await request<{ html_url: string }>(
      "POST",
      "/gists",
      token,
      { description, files: gistFiles, public: isPublic },
    );
    return data.html_url;
  }
}

// ── GitHub API response types (internal) ────────────────────────────────

interface GHUser {
  login: string;
}

interface GHLabel {
  name: string;
}

interface GHPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged: boolean;
  user: GHUser | null;
  created_at: string;
  updated_at: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  additions: number;
  deletions: number;
  changed_files: number;
  requested_reviewers: GHUser[];
  labels: GHLabel[];
  html_url: string;
  mergeable: boolean | null;
  draft: boolean;
}

interface GHComment {
  id: number;
  user: GHUser | null;
  body: string | null;
  created_at: string;
}

interface GHReviewComment {
  id: number;
  user: GHUser | null;
  body: string | null;
  created_at: string;
  path: string;
  line: number | null;
  original_line: number | null;
  side: string;
  in_reply_to_id?: number;
}

interface GHReview {
  id: number;
  user: GHUser | null;
  state: string;
  body: string | null;
  submitted_at: string;
}

function mapPR(data: GHPullRequest): PullRequest {
  let state: PullRequest["state"];
  if (data.merged) {
    state = "merged";
  } else if (data.state === "closed") {
    state = "closed";
  } else {
    state = "open";
  }

  return {
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    state,
    author: data.user?.login ?? "unknown",
    createdAt: new Date(data.created_at),
    updatedAt: new Date(data.updated_at),
    headBranch: data.head.ref,
    baseBranch: data.base.ref,
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    changedFiles: data.changed_files ?? 0,
    reviewers: data.requested_reviewers?.map((r) => r.login) ?? [],
    labels: data.labels?.map((l) => l.name) ?? [],
    url: data.html_url,
    mergeable: data.mergeable ?? false,
    draft: data.draft ?? false,
  };
}

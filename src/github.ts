import fs from "node:fs";
import { z } from "zod";
import { recordSchemas } from "./collaboration.js";
import type { Room } from "./db.js";

const repoSchema = z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
export interface GitHubConfig {
  repos: string[];
  token?: string;
  intervalSeconds: number;
}
export function githubConfig(
  env: NodeJS.ProcessEnv = process.env,
): GitHubConfig {
  const repos = z
    .array(repoSchema)
    .max(20)
    .parse(
      (env.ONEROOM_GITHUB_REPOS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  const intervalSeconds = z.coerce
    .number()
    .int()
    .min(60)
    .max(86400)
    .parse(env.ONEROOM_GITHUB_SYNC_SECONDS ?? 300);
  let token = env.ONEROOM_GITHUB_TOKEN;
  if (env.ONEROOM_GITHUB_TOKEN_FILE) {
    const stat = fs.statSync(env.ONEROOM_GITHUB_TOKEN_FILE);
    if (stat.size > 4096 || (process.platform !== "win32" && stat.mode & 0o077))
      throw new Error("GitHub token file must be <=4096 bytes and mode 0600");
    token = fs.readFileSync(env.ONEROOM_GITHUB_TOKEN_FILE, "utf8").trim();
  }
  return { repos, token, intervalSeconds };
}
type Json = Record<string, any>;
/** Read-only GitHub.com integration. Hosts and repository scope are operator-owned. */
export class GitHubSync {
  private busy = false;
  private state: {
    configured_repos: string[];
    running: boolean;
    last_attempt: string | null;
    last_success: string | null;
    error: string | null;
  };
  private controller = new AbortController();
  constructor(
    private room: Room,
    private cfg: GitHubConfig,
    private request: typeof fetch = fetch,
  ) {
    this.state = {
      configured_repos: [...cfg.repos],
      running: false,
      last_attempt: null,
      last_success: null,
      error: null,
    };
  }
  status() {
    return { ...this.state, running: this.busy };
  }
  stop() {
    this.controller.abort();
  }
  private async get(path: string): Promise<any> {
    const response = await this.request(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.cfg.token
          ? { Authorization: `Bearer ${this.cfg.token}` }
          : {}),
      },
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(15000),
      ]),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    if (!response.body) throw new Error("Empty GitHub response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024)
          throw new Error("GitHub page exceeds 8 MiB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  private async pages(path: string, field?: string): Promise<Json[]> {
    const all: Json[] = [];
    let bytes = 0;
    for (let page = 1; page <= 10; page++) {
      const value = await this.get(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const items = field ? value[field] : value;
      if (!Array.isArray(items)) throw new Error("Invalid GitHub response");
      bytes += Buffer.byteLength(JSON.stringify(items));
      if (bytes > 16 * 1024 * 1024)
        throw new Error("GitHub listing exceeds 16 MiB; snapshot incomplete");
      all.push(...items);
      if (items.length < 100) return all;
    }
    throw new Error("GitHub pagination limit reached; snapshot incomplete");
  }
  private async pull(repo: string, pull: Json) {
    const number = z.number().int().positive().parse(pull.number);
    const sha = z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(pull.head?.sha);
    let review = "unknown",
      ci = "unknown";
    // Failure to read either CI source must never become a successful check.
    try {
      const [reviews, checks, status] = await Promise.all([
        this.pages(`/repos/${repo}/pulls/${number}/reviews`),
        this.pages(
          `/repos/${repo}/commits/${sha}/check-runs?filter=latest`,
          "check_runs",
        ),
        this.get(`/repos/${repo}/commits/${sha}/status`),
      ]);
      const latest = new Map<string, string>();
      for (const r of reviews)
        if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state))
          latest.set(String(r.user?.id), r.state);
      review = [...latest.values()].includes("CHANGES_REQUESTED")
        ? "changes_requested"
        : [...latest.values()].includes("APPROVED")
          ? "approved"
          : "awaiting_review";
      const failures = checks.some((c) =>
        [
          "failure",
          "timed_out",
          "canceled",
          "cancelled",
          "action_required",
          "startup_failure",
          "stale",
        ].includes(c.conclusion),
      );
      const pending = checks.some((c) => c.status !== "completed");
      const unknown = checks.some(
        (c) =>
          c.status === "completed" &&
          ![
            "success",
            "neutral",
            "skipped",
            "failure",
            "timed_out",
            "canceled",
            "cancelled",
            "action_required",
            "startup_failure",
            "stale",
          ].includes(c.conclusion),
      );
      const statusCount = Number(status.total_count ?? 0);
      ci =
        failures ||
        (statusCount > 0 && ["failure", "error"].includes(status.state))
          ? "failure"
          : pending || (statusCount > 0 && status.state === "pending")
            ? "pending"
            : unknown ||
                (statusCount > 0 &&
                  !["success", "pending", "failure", "error"].includes(
                    status.state,
                  )) ||
                (!checks.length && !statusCount)
              ? "unknown"
              : "success";
    } catch {
      review = "unknown";
      ci = "unknown";
    }
    const data = {
      repo,
      number,
      url: `https://github.com/${repo}/pull/${number}`,
      title: pull.title,
      description: pull.body ?? "",
      state: pull.merged_at ? "merged" : pull.state,
      draft: Boolean(pull.draft),
      head_sha: sha,
      review,
      ci,
      synced_at: new Date().toISOString(),
      source: "github",
    };
    this.room.collaboration.syncPr(recordSchemas.pr.parse(data));
  }
  async sync() {
    if (this.busy) return this.status();
    this.busy = true;
    this.state.last_attempt = new Date().toISOString();
    this.state.error = null;
    try {
      for (const repo of this.cfg.repos) {
        const pulls = await this.pages(
          `/repos/${repo}/pulls?state=open&sort=created&direction=asc`,
        );
        const open = new Set(pulls.map((p) => p.number));
        // Explicitly fetch formerly-open PRs missing from the list. Missing from a
        // partial listing is not evidence that a PR was closed or merged.
        let after = 0;
        const seen = new Set<string>();
        while (true) {
          const page = this.room.collaboration.records("pr", after, 100);
          for (const record of page.items) {
            if (seen.has(record.key)) continue;
            seen.add(record.key);
            const old = this.room.collaboration.latest("pr", record.key)!;
            if (
              old.data.repo === repo &&
              old.data.state === "open" &&
              !open.has(old.data.number)
            )
              await this.pull(
                repo,
                await this.get(`/repos/${repo}/pulls/${old.data.number}`),
              );
          }
          if (!page.has_more) break;
          after = page.next_cursor!;
        }
        for (const pull of pulls) await this.pull(repo, pull);
      }
      this.state.last_success = new Date().toISOString();
    } catch (e) {
      this.state.error =
        e instanceof Error &&
        /^(GitHub|Invalid GitHub|Empty GitHub)/.test(e.message)
          ? e.message
          : "PR sync failed; previous snapshots retained";
    } finally {
      this.busy = false;
    }
    return this.status();
  }
}

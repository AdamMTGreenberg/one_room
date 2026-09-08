import type { RequestHandler } from "express";

// Fixed-cardinality metrics: never use a path, query string, identity or body as a label.
export class Operations {
  active = 0;
  private requests = 0;
  private errors = 0;
  private durationMs = 0;
  private toolCalls = 0;
  private toolErrors = 0;
  recordTool = (success: boolean) => { this.toolCalls++; if (!success) this.toolErrors++; };
  readonly middleware: RequestHandler = (_req, res, next) => {
    this.active++;
    const start = performance.now();
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      this.active--; this.requests++;
      if (res.statusCode >= 400 || !res.writableFinished) this.errors++;
      this.durationMs += performance.now() - start;
    };
    res.on("finish", finish); res.on("close", finish);
    next();
  };
  snapshot() { return { requests: this.requests, errors: this.errors, tool_calls: this.toolCalls, tool_errors: this.toolErrors, active_requests: this.active,
    total_duration_ms: Math.round(this.durationMs), mean_duration_ms: this.requests ? Math.round(this.durationMs / this.requests) : 0,
    rss_bytes: process.memoryUsage().rss, uptime_seconds: Math.floor(process.uptime()) }; }
}

export class RateLimiter {
  private buckets = new Map<string, { count: number; reset: number }>();
  constructor(private limit: number, private maxKeys = 4096) {}
  take(key: string, now = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (bucket && bucket.reset <= now) { this.buckets.delete(key); bucket = undefined; }
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        for (const [k, b] of this.buckets) if (b.reset <= now) this.buckets.delete(k);
        // Refuse new identities while full; do not evict active buckets to bypass limits.
        if (this.buckets.size >= this.maxKeys) return false;
      }
      bucket = { count: 0, reset: now + 60000 }; this.buckets.set(key, bucket);
    }
    return ++bucket.count <= this.limit;
  }
}

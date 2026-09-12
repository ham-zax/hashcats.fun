import { performance } from "node:perf_hooks";

export const now = () => performance.now();

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** Bounded storage; totals cover the run, percentiles cover the recent window. */
export class Distribution {
  constructor(capacity = 2048) {
    this.capacity = capacity;
    this.count = 0;
    this.sum = 0;
    this.minimum = Infinity;
    this.maximum = -Infinity;
    this.recent = [];
  }

  record(value) {
    if (!Number.isFinite(value) || value < 0) return;
    // Deliberate bounded mutation: avoid copying thousands of values per GPU batch.
    this.recent[this.count % this.capacity] = value;
    this.count++;
    this.sum += value;
    this.minimum = Math.min(this.minimum, value);
    this.maximum = Math.max(this.maximum, value);
  }

  summary() {
    return { count: this.count, mean: this.count ? this.sum / this.count : null,
      min: this.count ? this.minimum : null, max: this.count ? this.maximum : null,
      percentileWindow: this.recent.length, p50: percentile(this.recent, 0.5),
      p95: percentile(this.recent, 0.95), p99: percentile(this.recent, 0.99) };
  }
}

export class StageTimer {
  constructor() { this.started = now(); this.previous = this.started; this.stages = {}; }
  mark(name) {
    const timestamp = now();
    this.stages = { ...this.stages, [name]: timestamp - this.previous };
    this.previous = timestamp;
  }
  summary() { return { stagesMs: this.stages, elapsedMs: now() - this.started }; }
}

import { Injectable, OnModuleDestroy } from '@nestjs/common';

/** In-memory state for a single service instance. */
interface ChaosState {
  latencyMs: number;
  latencyExpiresAt: Date | null;

  errorRatePercent: number;
  errorRateExpiresAt: Date | null;

  memoryLeakEnabled: boolean;
  memoryLeakExpiresAt: Date | null;
  memoryLeakRetainedMb: number;

  /** Not serialised to GET /chaos/state */
  _leakArray: unknown[];
  _leakTimer: NodeJS.Timeout | null;
  _latencyTimer: NodeJS.Timeout | null;
  _errorRateTimer: NodeJS.Timeout | null;
}

/** Serialisable snapshot returned by GET /chaos/state (Requirements: 7.5). */
export interface ChaosStateResponse {
  latencyMs: number;
  latencyExpiresAt: string | null; // ISO 8601
  errorRatePercent: number;
  errorRateExpiresAt: string | null;
  memoryLeakEnabled: boolean;
  memoryLeakRetainedMb: number;
  memoryLeakExpiresAt: string | null;
}

/** 1 MB as a string length — each JS char is 2 bytes so 512 k chars ≈ 1 MB. */
const ONE_MB_STRING_LENGTH = 512 * 1024;

function buildInitialState(): ChaosState {
  return {
    latencyMs: 0,
    latencyExpiresAt: null,
    errorRatePercent: 0,
    errorRateExpiresAt: null,
    memoryLeakEnabled: false,
    memoryLeakExpiresAt: null,
    memoryLeakRetainedMb: 0,
    _leakArray: [],
    _leakTimer: null,
    _latencyTimer: null,
    _errorRateTimer: null,
  };
}

/**
 * ChaosService
 *
 * Manages per-service chaos state: latency injection, error-rate injection,
 * simulated memory leaks, and a process crash trigger.
 *
 * All chaos settings self-expire after CHAOS_TTL_SECONDS (default 120 s).
 * The memory-leak TTL also frees the retained byte array, while a manual
 * disable() keeps the array in memory until reset() or TTL expiry.
 *
 * Requirements: 3.1, 3.2, 4.1, 4.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2,
 *               7.1, 7.2, 7.4, 7.5
 */
@Injectable()
export class ChaosService implements OnModuleDestroy {
  /** Exposed (read-only intent) so ChaosInterceptor can sample it cheaply. */
  readonly state: ChaosState = buildInitialState();

  /** Seconds before any active chaos setting auto-expires. Requirements: 7.4 */
  private readonly ttlSeconds: number;

  /** MB per second pushed into the leak array. Requirements: 5.3 */
  private readonly leakMbPerSecond: number;

  constructor() {
    this.ttlSeconds = parseInt(process.env['CHAOS_TTL_SECONDS'] ?? '120', 10);
    this.leakMbPerSecond = parseInt(
      process.env['LEAK_MB_PER_SECOND'] ?? '5',
      10,
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onModuleDestroy(): void {
    // Clear all timers so Jest and Docker shut down cleanly.
    this.clearAllTimers();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Set synthetic latency.
   *
   * Cancels any existing TTL timer and starts a fresh one.
   * Requirements: 3.1, 3.2
   */
  setLatency(ms: number): void {
    this.state.latencyMs = ms;
    this.state.latencyExpiresAt = this.expiresAt();

    if (this.state._latencyTimer !== null) {
      clearTimeout(this.state._latencyTimer);
    }

    this.state._latencyTimer = setTimeout(() => {
      this.resetLatency();
    }, this.ttlSeconds * 1000);
  }

  /**
   * Set the probability that any given request returns HTTP 500.
   *
   * Cancels any existing TTL timer and starts a fresh one.
   * Requirements: 4.1, 4.2
   */
  setErrorRate(percentage: number): void {
    this.state.errorRatePercent = percentage;
    this.state.errorRateExpiresAt = this.expiresAt();

    if (this.state._errorRateTimer !== null) {
      clearTimeout(this.state._errorRateTimer);
    }

    this.state._errorRateTimer = setTimeout(() => {
      this.resetErrorRate();
    }, this.ttlSeconds * 1000);
  }

  /**
   * Start growing a byte array to simulate a memory leak.
   *
   * A 1 000 ms interval pushes LEAK_MB_PER_SECOND × 1 MB strings.
   * A TTL timer stops the interval AND frees the array on expiry.
   * Requirements: 5.1, 5.2, 5.3
   */
  enableMemoryLeak(): void {
    // Idempotent — stop any existing leak timer before starting a new one.
    if (this.state._leakTimer !== null) {
      clearInterval(this.state._leakTimer);
    }

    this.state.memoryLeakEnabled = true;
    this.state.memoryLeakExpiresAt = this.expiresAt();

    // Schedule the TTL expiry that stops the leak AND frees the array.
    // We clear _errorRateTimer here only if it was being reused; TTL timers
    // for the leak are tracked separately via the existing _latencyTimer /
    // _errorRateTimer pattern — for the leak we piggyback the expiry onto
    // the _leakTimer slot that is currently free.
    // Reuse the existing _latencyTimer slot? No — the leak has its own
    // independent TTL. We store it in a dedicated local timeout and clear it
    // via a dedicated private helper.
    if (this._leakExpiryTimer !== null) {
      clearTimeout(this._leakExpiryTimer);
    }

    this._leakExpiryTimer = setTimeout(() => {
      this.expireMemoryLeak();
    }, this.ttlSeconds * 1000);

    // Push LEAK_MB_PER_SECOND × 1 MB of strings every 1 000 ms.
    this.state._leakTimer = setInterval(() => {
      for (let i = 0; i < this.leakMbPerSecond; i++) {
        // A string of ONE_MB_STRING_LENGTH chars ≈ 1 MB of heap.
        this.state._leakArray.push('x'.repeat(ONE_MB_STRING_LENGTH));
      }
      this.state.memoryLeakRetainedMb += this.leakMbPerSecond;
    }, 1000);
  }

  /**
   * Stop growing the leak array without freeing retained memory.
   *
   * The array is only freed on reset() or when the TTL expires.
   * Requirements: 5.4
   */
  disableMemoryLeak(): void {
    if (this.state._leakTimer !== null) {
      clearInterval(this.state._leakTimer);
      this.state._leakTimer = null;
    }
    this.state.memoryLeakEnabled = false;
  }

  /**
   * Zero all chaos settings, clear all timers, and free the leak array.
   *
   * Requirements: 7.1, 7.2
   */
  reset(): void {
    this.clearAllTimers();

    this.state.latencyMs = 0;
    this.state.latencyExpiresAt = null;
    this.state.errorRatePercent = 0;
    this.state.errorRateExpiresAt = null;
    this.state.memoryLeakEnabled = false;
    this.state.memoryLeakExpiresAt = null;
    this.state.memoryLeakRetainedMb = 0;
    this.state._leakArray = [];
  }

  /**
   * Return a serialisable snapshot of the current chaos state.
   *
   * Internal timer handles and _leakArray are excluded.
   * Requirements: 7.5
   */
  getState(): ChaosStateResponse {
    return {
      latencyMs: this.state.latencyMs,
      latencyExpiresAt: this.state.latencyExpiresAt?.toISOString() ?? null,
      errorRatePercent: this.state.errorRatePercent,
      errorRateExpiresAt:
        this.state.errorRateExpiresAt?.toISOString() ?? null,
      memoryLeakEnabled: this.state.memoryLeakEnabled,
      memoryLeakRetainedMb: this.state.memoryLeakRetainedMb,
      memoryLeakExpiresAt:
        this.state.memoryLeakExpiresAt?.toISOString() ?? null,
    };
  }

  /**
   * Schedule a process.exit(1) 100 ms from now.
   *
   * The 100 ms delay lets the HTTP response be flushed before the process
   * terminates, so the caller receives the 202 body.
   * Requirements: 6.1, 6.2
   */
  crash(): void {
    setTimeout(() => {
      process.exit(1);
    }, 100);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Dedicated expiry timer for the memory-leak TTL.  Stored outside
   * ChaosState because it is not part of the chaos state data model — it is
   * purely an implementation detail of the service.
   */
  private _leakExpiryTimer: NodeJS.Timeout | null = null;

  /** Compute the wall-clock expiry Date for a new chaos setting. */
  private expiresAt(): Date {
    return new Date(Date.now() + this.ttlSeconds * 1000);
  }

  /** Reset latency to zero (called by TTL timer). */
  private resetLatency(): void {
    this.state.latencyMs = 0;
    this.state.latencyExpiresAt = null;
    this.state._latencyTimer = null;
  }

  /** Reset error rate to zero (called by TTL timer). */
  private resetErrorRate(): void {
    this.state.errorRatePercent = 0;
    this.state.errorRateExpiresAt = null;
    this.state._errorRateTimer = null;
  }

  /**
   * TTL expiry for memory leak: stops the interval AND frees the array.
   * Requirements: 5.2
   */
  private expireMemoryLeak(): void {
    if (this.state._leakTimer !== null) {
      clearInterval(this.state._leakTimer);
      this.state._leakTimer = null;
    }
    this.state.memoryLeakEnabled = false;
    this.state.memoryLeakExpiresAt = null;
    this.state.memoryLeakRetainedMb = 0;
    this.state._leakArray = []; // free retained memory
    this._leakExpiryTimer = null;
  }

  /** Clear every active timer. Used by reset() and onModuleDestroy(). */
  private clearAllTimers(): void {
    if (this.state._latencyTimer !== null) {
      clearTimeout(this.state._latencyTimer);
      this.state._latencyTimer = null;
    }

    if (this.state._errorRateTimer !== null) {
      clearTimeout(this.state._errorRateTimer);
      this.state._errorRateTimer = null;
    }

    if (this.state._leakTimer !== null) {
      clearInterval(this.state._leakTimer);
      this.state._leakTimer = null;
    }

    if (this._leakExpiryTimer !== null) {
      clearTimeout(this._leakExpiryTimer);
      this._leakExpiryTimer = null;
    }
  }
}

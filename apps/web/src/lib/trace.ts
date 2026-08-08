/**
 * Protocol trace — the M6 observability seam (Codex M6 consult §2).
 *
 * A PASSIVE, SANITIZED record of protocol traffic for the e2e build:
 * metadata only — never query surfaces, byte buffers, result arrays, KWIC
 * rows, or Reader text, so the trace can neither leak source text nor
 * retain large typed arrays. The ring is bounded; overflow is visible as a
 * dropped-event count, never silent. Snapshots return copies.
 */

export interface ProtocolTraceEvent {
  readonly seq: number;
  /** Main-thread performance.now() at record time. */
  readonly at: number;
  readonly direction: 'to-worker' | 'from-worker' | 'client';
  readonly t: string;
  readonly job?: number;
  readonly generation?: string;
  readonly snapshot?: string | null;
  readonly doc?: string;
  readonly phase?: string;
  readonly op?: string;
  readonly readyCount?: number;
  readonly missingCount?: number;
  readonly code?: string;
  /** Ingest transfer instrumentation: buffer byteLength immediately before
   *  and after postMessage — detachment is synchronous, so 0 after proves
   *  a real transfer, not a clone. */
  readonly transferBytesBefore?: number;
  readonly transferBytesAfter?: number;
}

export interface TraceSnapshot {
  readonly events: readonly ProtocolTraceEvent[];
  readonly dropped: number;
}

export interface ProtocolTraceSink {
  record(event: Omit<ProtocolTraceEvent, 'seq' | 'at'>): void;
}

export class RingTrace implements ProtocolTraceSink {
  private readonly capacity: number;
  private readonly ring: ProtocolTraceEvent[] = [];
  private nextSeq = 0;
  private dropped = 0;

  constructor(capacity = 5000) {
    this.capacity = capacity;
  }

  record(event: Omit<ProtocolTraceEvent, 'seq' | 'at'>): void {
    if (this.ring.length >= this.capacity) {
      this.ring.shift();
      this.dropped++;
    }
    this.ring.push({ ...event, seq: this.nextSeq++, at: performance.now() });
  }

  snapshot(): TraceSnapshot {
    return { events: this.ring.map((e) => ({ ...e })), dropped: this.dropped };
  }

  clear(): void {
    this.ring.length = 0;
    this.dropped = 0;
  }
}

/**
 * Minimal ambient declarations for the Web-platform globals the core uses.
 * All exist in every supported runtime (browsers, Node ≥ 20 workers/main),
 * but the core's tsconfig deliberately includes neither DOM nor Node type
 * libs — this package is environment-agnostic and gets exactly these.
 */

declare const crypto: {
  readonly subtle: {
    digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
  };
};

declare class TextEncoder {
  encode(input: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}

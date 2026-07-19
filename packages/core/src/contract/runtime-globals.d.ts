/**
 * Minimal ambient declarations for the two Web-platform globals the core uses.
 * Both exist in every supported runtime (browsers, Node ≥ 20 workers/main), but
 * the core's tsconfig deliberately includes neither DOM nor Node type libs —
 * this package is environment-agnostic and gets exactly these two globals.
 */

declare const crypto: {
  readonly subtle: {
    digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
  };
};

declare class TextEncoder {
  encode(input: string): Uint8Array;
}

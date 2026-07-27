/**
 * Minimal ambient declarations for the Web-platform globals used by this
 * package and by @texttrends/core's source (which every consumer re-typechecks,
 * since core is consumed as raw TS). Mirrors core's own runtime-globals.d.ts:
 * this package is environment-agnostic and deliberately pulls in neither DOM
 * nor Node type libs.
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

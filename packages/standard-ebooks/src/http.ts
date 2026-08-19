import { StandardEbooksError, isAbortError } from './errors.js';
import type { FetchLike, GitHubRateLimit } from './types.js';

const ERROR_BODY_LIMIT = 500;

export async function fetchChecked(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (isAbortError(error) || init.signal?.aborted === true) {
      throw new StandardEbooksError('ABORTED', `Request aborted: ${url}`, { url, cause: error });
    }
    throw new StandardEbooksError('NETWORK_ERROR', `Network request failed: ${url}`, {
      url,
      cause: error,
    });
  }

  if (response.ok) return response;

  const rateLimit = githubRateLimit(response.headers);
  const code =
    response.status === 429 || (response.status === 403 && rateLimit.remaining === 0)
      ? 'RATE_LIMITED'
      : 'HTTP_ERROR';
  let detail = '';
  try {
    detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_LIMIT);
  } catch {
    // The status and URL remain sufficient if the error body cannot be read.
  }
  throw new StandardEbooksError(
    code,
    `HTTP ${response.status} for ${url}${detail === '' ? '' : `: ${detail}`}`,
    { status: response.status, url },
  );
}

function headerInteger(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function githubRateLimit(headers: Headers): GitHubRateLimit {
  const reset = headerInteger(headers, 'x-ratelimit-reset');
  return {
    limit: headerInteger(headers, 'x-ratelimit-limit'),
    remaining: headerInteger(headers, 'x-ratelimit-remaining'),
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
  };
}

/**
 * A shared aggregate byte budget, charged WHILE response bodies are read, so
 * an acquisition stage can bound the TOTAL bytes downloaded across many
 * concurrent responses — not just each response individually. `charge` throws
 * once the aggregate exceeds the budget; the caller's read is cancelled.
 */
export interface ByteBudget {
  charge(byteCount: number): void;
}

export interface ReadResponseBytesOptions {
  /** Shared aggregate budget, charged while the body is read. */
  readonly budget?: ByteBudget | undefined;
  /**
   * The signal governing THIS read (the same one the fetch was issued with),
   * consulted to classify read failures: `abort(reason)` propagates the
   * caller's arbitrary reason into the body stream, so the thrown error alone
   * cannot identify an abort.
   */
  readonly signal?: AbortSignal | null | undefined;
}

/**
 * Body reads can fail AFTER `fetch()` itself resolved — an abort or transport
 * drop mid-stream surfaces from `reader.read()`/`arrayBuffer()`, not from the
 * fetch call `fetchChecked` guards. Map those onto the library's error
 * contract: aborts become `ABORTED` (callers such as a cache wrapper must
 * distinguish abort from transient failure and never treat cancellation as
 * fallback-eligible), other transport failures become `NETWORK_ERROR`, and
 * errors already shaped by this library (for example the budget's
 * `CAP_EXCEEDED`) pass through untouched — checked FIRST, so a cap trip while
 * the signal happens to be aborted stays a cap trip.
 */
function wrapBodyReadError(
  error: unknown,
  label: string,
  responseOptions: { readonly url?: string },
  signal: AbortSignal | null | undefined,
): never {
  if (error instanceof StandardEbooksError) throw error;
  if (isAbortError(error) || signal?.aborted === true) {
    throw new StandardEbooksError('ABORTED', `${label} read aborted`, {
      ...responseOptions,
      cause: error,
    });
  }
  throw new StandardEbooksError('NETWORK_ERROR', `${label} body could not be read`, {
    ...responseOptions,
    cause: error,
  });
}

export async function readResponseBytes(
  response: Response,
  maximumBytes: number,
  label: string,
  options: ReadResponseBytesOptions = {},
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError('maximumBytes must be a positive safe integer');
  }

  const declared = response.headers.get('content-length');
  const responseOptions = response.url === '' ? {} : { url: response.url };
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    throw new StandardEbooksError(
      'CAP_EXCEEDED',
      `${label} is ${declared} bytes; the limit is ${maximumBytes} bytes`,
      responseOptions,
    );
  }

  if (response.body === null) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      wrapBodyReadError(error, label, responseOptions, options.signal);
    }
    if (bytes.byteLength > maximumBytes) {
      throw new StandardEbooksError(
        'CAP_EXCEEDED',
        `${label} is ${bytes.byteLength} bytes; the limit is ${maximumBytes} bytes`,
        responseOptions,
      );
    }
    options.budget?.charge(bytes.byteLength);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    let item: ReadableStreamReadResult<Uint8Array>;
    try {
      item = await reader.read();
    } catch (error) {
      wrapBodyReadError(error, label, responseOptions, options.signal);
    }
    if (item.done) break;
    length += item.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel('size limit exceeded');
      throw new StandardEbooksError(
        'CAP_EXCEEDED',
        `${label} exceeds the ${maximumBytes}-byte limit`,
        responseOptions,
      );
    }
    try {
      options.budget?.charge(item.value.byteLength);
    } catch (error) {
      await reader.cancel('shared byte budget exceeded');
      throw error;
    }
    chunks.push(item.value);
  }

  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

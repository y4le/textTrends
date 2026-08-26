/** Restore the path removed by a path-scoped Tailscale Serve proxy. */
export function restoreTailnetRequestUrl(requestUrl: string, path: string): string {
  const base = `${path}/`;
  const suffixIndex = requestUrl.search(/[?#]/);
  const pathname = suffixIndex === -1 ? requestUrl : requestUrl.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : requestUrl.slice(suffixIndex);

  if (pathname === path) return `${base}${suffix}`;
  if (pathname.startsWith(base)) return requestUrl;
  return `${path}${pathname.startsWith('/') ? '' : '/'}${pathname}${suffix}`;
}

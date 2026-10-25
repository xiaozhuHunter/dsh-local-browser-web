/**
 * Resolve click-tracker result URLs back to their destinations.
 *
 * Some engines stop publishing the destination in the DOM. Google's SERP now
 * ships `/goto?url=<opaque token>` anchors whose token only the server can
 * decrypt, so the single reliable way back is to ask the tracker and read the
 * `Location` of the 302 it answers with. That costs one header-only request per
 * result — no page is downloaded, because the hop is not followed.
 *
 * Which URLs need this is declared per engine (`unwrapRedirect`), so no engine
 * pays for it unless it says so.
 *
 * @module dsh-local-browser-web/engines/unwrap
 */
import type { HttpLimits } from '../http.ts'
import { httpGet } from '../http.ts'
import type { ProxySpec } from '../proxy.ts'
import type { RawSearchSource } from '../types.ts'

/** How many trackers are resolved at once. */
const UNWRAP_CONCURRENCY = 4

/** Attempts per tracker. A flaky egress drops a header-only hop easily; one retry
 * turns "some links stay wrapped" into "almost none do". */
const UNWRAP_ATTEMPTS = 2

/** A resolved hop is only plausible as a destination when it is an HTTP(S) URL. */
const DESTINATION = /^https?:\/\//iu

/** Resolve one tracker without ever failing the search it belongs to. */
async function resolveOne(
  url: string,
  limits: HttpLimits,
  proxy: ProxySpec | undefined,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  for (let attempt = 1; attempt <= UNWRAP_ATTEMPTS; attempt += 1) {
    if (signal?.aborted === true) return undefined
    try {
      const hop = await httpGet({
        url,
        // The body is never read, so the document caps do not apply. A tracker
        // answers a header-only request in milliseconds; anything near the search
        // budget is a hung hop that the retry will not rescue either.
        limits: {
          ...limits,
          timeoutMs: Math.min(limits.timeoutMs, 6_000),
          maxRedirects: 0,
          maxResponseBytes: 64_000,
          maxBodyChars: 1_024,
        },
        followRedirects: false,
        ...proxy === undefined ? {} : { proxy },
        ...signal === undefined ? {} : { signal },
      })
      const location = hop.location
      if (location === undefined || !DESTINATION.test(location)) return undefined
      return location
    } catch {
      // A tracker that refuses the hop keeps its URL: a clickable tracker is still
      // a usable source, and dropping the result would be a worse trade. Retrying
      // only helps a transient failure, which is what a proxy hop usually is.
    }
  }
  return undefined
}

/** Run `work` over `items` with a bounded number in flight. */
async function pool<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const index = next++
      const item = items[index]
      if (item === undefined) return
      await work(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Rewrite tracker URLs in place, preserving order and every other field.
 *
 * @param sources - parsed results, possibly carrying tracker URLs.
 * @param options - the engine's tracker pattern plus the HTTP budget and egress.
 * @returns the same list with resolvable trackers replaced by their destination.
 */
export async function unwrapRedirects(
  sources: readonly RawSearchSource[],
  options: {
    /** Regex source, supplied by the engine that knows its own tracker shape. */
    pattern: string
    limits: HttpLimits
    proxy?: ProxySpec
    signal?: AbortSignal
  },
): Promise<RawSearchSource[]> {
  let matcher: RegExp
  try {
    matcher = new RegExp(options.pattern, 'u')
  } catch {
    // A malformed pattern is a config bug the engine validator reports; here it
    // must not cost the caller its results.
    return [...sources]
  }

  const indexes: number[] = []
  for (const [index, source] of sources.entries()) {
    if (matcher.test(source.url)) indexes.push(index)
  }
  if (indexes.length === 0) return [...sources]

  const resolved = new Map<number, string>()
  await pool(indexes, UNWRAP_CONCURRENCY, async (index) => {
    const source = sources[index]
    if (source === undefined) return
    const destination = await resolveOne(source.url, options.limits, options.proxy, options.signal)
    if (destination !== undefined) resolved.set(index, destination)
  })

  return sources.map((source, index) => {
    const destination = resolved.get(index)
    return destination === undefined ? source : { ...source, url: destination }
  })
}

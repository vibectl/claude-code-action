/**
 * Fetch Interceptor — Injects proxy authentication headers on GitHub API requests.
 *
 * When the egress proxy URL is configured, all fetch requests matching
 * the proxy URL prefix receive X-Proxy-Token and X-Egress-Mode headers.
 * Non-matching requests pass through unmodified.
 *
 * Security: The proxy token is a per-task HMAC credential. It MUST NOT
 * be sent to any host other than the configured proxy URL. URL matching
 * uses startsWith on the full URL (scheme + host + path prefix) to
 * prevent token leakage to similar-looking domains.
 *
 * Scope limitation: HTTP redirect responses (301/302/307/308) are not
 * intercepted. The browser/runtime follows redirects natively, and the
 * proxy headers are not re-injected on the redirected request. This is
 * acceptable for current CCA usage — GitHub REST/GraphQL APIs and the
 * egress proxy return direct responses, not redirects.
 */

export interface FetchInterceptorConfig {
  /** The GitHub API proxy URL prefix to match against */
  githubApiUrl: string;
  /** HMAC proxy authentication token (format: {expiry}:{base64_signature}) */
  proxyToken: string;
  /** Egress scanning mode */
  egressMode?: "full" | "relay";
}

/** Bun-compatible fetch input type */
type FetchInput = string | URL | Request;

let originalFetch: typeof globalThis.fetch | undefined;

/**
 * Install a fetch interceptor that injects proxy headers on matching requests.
 *
 * Replaces globalThis.fetch with a wrapper that adds X-Proxy-Token and
 * X-Egress-Mode headers to requests whose URL starts with githubApiUrl.
 * All other requests pass through to the original fetch unmodified.
 */
export function installFetchInterceptor(config: FetchInterceptorConfig): void {
  const { githubApiUrl, proxyToken, egressMode = "full" } = config;

  // Normalize: ensure the URL prefix ends with "/" for safe prefix matching.
  // This prevents "https://proxy.test" from matching "https://proxy.test.evil.com".
  const urlPrefix = githubApiUrl.endsWith("/")
    ? githubApiUrl
    : `${githubApiUrl}/`;

  // Store original fetch for restoration and delegation
  originalFetch = globalThis.fetch;
  const delegate = originalFetch;

  const interceptor = async (
    input: FetchInput,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = extractUrl(input);

    // Match: URL starts with the proxy prefix, or IS the proxy URL exactly
    if (url === githubApiUrl || url.startsWith(urlPrefix)) {
      const mergedInit = mergeHeaders(input, init, {
        "X-Proxy-Token": proxyToken,
        "X-Egress-Mode": egressMode,
      });
      return delegate(input, mergedInit);
    }

    // Non-matching: pass through unmodified
    return delegate(input, init);
  };

  // Preserve the preconnect method from the original fetch (Bun-specific)
  if ("preconnect" in delegate) {
    (interceptor as typeof fetch).preconnect = (
      delegate as typeof fetch
    ).preconnect;
  }

  globalThis.fetch = interceptor as typeof fetch;
}

/**
 * Remove the fetch interceptor, restoring the original globalThis.fetch.
 * Safe to call multiple times.
 */
export function removeFetchInterceptor(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
}

/** Extract URL string from various input types */
function extractUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Merge additional headers into a RequestInit, preserving any existing headers.
 * Returns a new init object (does not mutate the original).
 */
function mergeHeaders(
  input: FetchInput,
  init: RequestInit | undefined,
  additionalHeaders: Record<string, string>,
): RequestInit {
  // Collect existing headers from init and/or Request object
  const existingHeaders = new Headers(init?.headers);

  // If input is a Request and no headers were provided in init, use Request headers
  if (!init?.headers && input instanceof Request) {
    input.headers.forEach((value: string, key: string) => {
      existingHeaders.set(key, value);
    });
  }

  // Add proxy headers
  for (const [key, value] of Object.entries(additionalHeaders)) {
    existingHeaders.set(key, value);
  }

  return {
    ...init,
    headers: Object.fromEntries(existingHeaders.entries()),
  };
}

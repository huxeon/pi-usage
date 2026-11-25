const DEFAULT_TIMEOUT_MS = 10_000;

export class UsageError extends Error {
  override name = "UsageError";
}

interface RequestOptions {
  service: string;
  url: string;
  apiKey: string;
  accountId?: string;
  authHint: string;
  timeoutMs?: number;
}

export async function fetchAccountJson(
  options: RequestOptions,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<unknown> {
  const { service, url, apiKey, accountId, authHint, timeoutMs } = options;
  const timeout = AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    combined.throwIfAborted();
    const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
    if (accountId !== undefined) headers["ChatGPT-Account-Id"] = accountId;
    const response = await request(url, { method: "GET", headers, redirect: "error", signal: combined });
    combined.throwIfAborted();
    if (!response.ok) {
      // Best-effort cleanup must not delay or replace the safe HTTP error.
      void response.body?.cancel().catch(() => {});
      const hint = response.status === 401 || response.status === 403
        ? `Authentication failed. ${authHint}`
        : response.status === 429 ? "Rate limit exceeded. Please try again later."
        : "Service unavailable. Please try again later.";
      throw new UsageError(`${service} request failed (HTTP ${response.status}): ${hint}`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      if (combined.aborted) throw combined.reason;
      throw new UsageError(`${service} returned invalid JSON.`);
    }
    combined.throwIfAborted();
    return data;
  } catch (error) {
    if (signal?.aborted) throw new UsageError("Usage query cancelled.");
    if (timeout.aborted) throw new UsageError(`${service} usage query timed out. Please try again.`);
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Unable to connect to ${service}. Check your network connection.`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

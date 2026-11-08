/**
 * fetch + JSON for buttons that start work. Never throws: every failure comes back as a message a
 * person can act on (offline, timed out, server error), so a tap never ends in silence.
 */
export type JsonResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string; data: Partial<T> & { error?: string } };

const SLOW = "The server took too long to answer. It may still have started: wait a minute and reload before trying again.";

export function networkMessage(status: number | null): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "You're offline. Nothing was started; try again when you're connected.";
  if (status === null) return "Couldn't reach the app. Check your connection and try again.";
  if (status === 401 || status === 403) return "Your session ended. Reload the page and sign in again.";
  if (status === 429) return "Too many requests right now. Wait a moment and try again.";
  if (status === 502 || status === 503 || status === 504) return SLOW;
  if (status >= 500) return "Something went wrong on the server. Nothing was changed; try again.";
  return `The request didn't go through (error ${status}).`;
}

export async function requestJSON<T = Record<string, unknown>>(url: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}): Promise<JsonResult<T>> {
  const { json, timeoutMs = 35000, ...rest } = init;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      ...rest,
      ...(json !== undefined ? { method: rest.method ?? "POST", body: JSON.stringify(json), headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) } } : {}),
      signal: ctl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, data, error: data?.error ?? networkMessage(res.status) };
    return { ok: true, status: res.status, data };
  } catch (e) {
    const timedOut = (e as Error)?.name === "AbortError";
    return { ok: false, status: 0, data: {} as Partial<T>, error: timedOut ? SLOW : networkMessage(null) };
  } finally {
    clearTimeout(timer);
  }
}

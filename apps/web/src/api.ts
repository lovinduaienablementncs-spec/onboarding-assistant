import { useCallback, useEffect, useState } from "react";
import { getToken } from "./auth";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function headers(json = false): Promise<HeadersInit> {
  return { Authorization: `Bearer ${await getToken()}`, ...(json ? { "Content-Type": "application/json" } : {}) };
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: await headers(init.body !== undefined),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: Array<{ path: string[]; message: string }> };
    const detail = body.issues?.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ApiError(res.status, detail || body.error || res.statusText);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Fetches a protected file (screenshot, video) and returns an object URL for <img>/<video>. */
export async function blobUrl(path: string): Promise<string> {
  const res = await fetch(`/api${path}`, { headers: await headers() });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return URL.createObjectURL(await res.blob());
}

/** POSTs and reads server-sent events from the response body. */
export async function streamEvents(path: string, body: unknown, onEvent: (type: string, data: unknown) => void): Promise<void> {
  const res = await fetch(`/api${path}`, { method: "POST", headers: await headers(true), body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new ApiError(res.status, res.statusText);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const type = /^event: (.*)$/m.exec(raw)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      onEvent(type, data ? JSON.parse(data) : null);
    }
  }
}

/** Loads a GET endpoint; `reload` refetches. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

export function useBlobUrl(path: string | null) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!path) return;
    let current: string | undefined;
    blobUrl(path).then((u) => setUrl((current = u))).catch(() => setUrl(undefined));
    return () => {
      if (current) URL.revokeObjectURL(current);
    };
  }, [path]);
  return url;
}

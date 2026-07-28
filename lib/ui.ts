// lib/ui.ts — client-side display helpers. DISPLAY ONLY: no money is ever
// computed here; the server's cents are just formatted.
export const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export const ageMinutes = (iso: string | Date) =>
  Math.floor((Date.now() - new Date(iso).getTime()) / 60000);

export async function api<T = unknown>(
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    ...(json !== undefined
      ? {
          method: rest.method ?? "POST",
          headers: { "content-type": "application/json", ...rest.headers },
          body: JSON.stringify(json),
        }
      : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

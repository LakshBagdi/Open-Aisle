/**
 * Shared by the barrier report (AG Grid) and the fix board (Bryntum):
 * the barrier shape, plain-English labels, and the calls to our API.
 */
export type BarrierStatus = "open" | "in_progress" | "fixed" | "dismissed";

export type Barrier = {
  id: string;
  kind: string;
  detail: string;
  timesHit: number;
  status: BarrierStatus;
  suggestedFix: string | null;
  productTitle: string;
  sku: string;
};

export const KIND_LABEL: Record<string, string> = {
  missing_alt_text: "Photo has no description",
  missing_size_chart: "No size chart",
  missing_return_policy: "No return policy",
  missing_material: "Material not listed",
  unclear_color: "Colour only in the photo",
};

export const STATUS_LABEL: Record<BarrierStatus, string> = {
  open: "Needs a fix",
  in_progress: "Being fixed",
  fixed: "Fixed",
  dismissed: "Not needed",
};

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

async function call<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    return (await res.json()) as Result<T>;
  } catch {
    return { ok: false, error: "Couldn't reach Open Aisle. Check your connection and try again." };
  }
}

export const barrierApi = {
  load: (storeId?: string) =>
    call<{ stores: { id: string; name: string }[]; storeId: string; barriers: Barrier[] }>(`/api/merchant/barriers${storeId ? `?store=${storeId}` : ""}`),
  setStatus: (storeId: string, barrierId: string, status: Exclude<BarrierStatus, "fixed">) =>
    call<{ message: string }>("/api/merchant/barriers", { method: "PATCH", body: JSON.stringify({ storeId, barrierId, status }) }),
  draft: (barrierId: string) => call<{ draft: { text: string; note: string; source: string } }>("/api/merchant/suggest", { method: "POST", body: JSON.stringify({ barrierId }) }),
  fix: (storeId: string, barrierId: string, fix: string) =>
    call<{ message: string }>("/api/merchant/barriers", { method: "POST", body: JSON.stringify({ storeId, barrierId, fix }) }),
};

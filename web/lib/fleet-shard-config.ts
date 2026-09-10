// Shared validation for dashboard-generated Fleet identities. Never infer MCC from a shard name.
export function normalizeFleetShardId(value: string): string {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id)) {
    throw new Error("A valid shard name is required: 1-80 letters, numbers, periods, underscores, colons or hyphens.");
  }
  return id;
}

export function normalizeFleetManagerId(value: string): string {
  const raw = String(value || "").trim();
  const id = raw.replace(/[\s-]/g, "");
  if (!/^[0-9\s-]+$/.test(raw) || !/^\d{10}$/.test(id)) {
    throw new Error("A valid 10-digit Google Ads MCC ID is required.");
  }
  return id;
}

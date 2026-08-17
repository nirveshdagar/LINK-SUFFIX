import data from './devices.json' with { type: 'json' };

export interface DeviceProfile {
  id: string;
  uaFamily: string;          // legacy single-UA — kept for back-compat
  viewport: { w: number; h: number; dpr: number };
  touch: boolean;
  hardware: { cores: number; memoryGb: number };
  webgl: { vendor: string; renderer: string };
  locale: string;
  templateIds: string[];     // NEW: ids into @tah/ua templates
}

const PROFILES: DeviceProfile[] = data as DeviceProfile[];

const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));

export function listProfiles(): DeviceProfile[] {
  return [...PROFILES];
}

export function loadProfile(id: string): DeviceProfile {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`unknown profile: ${id}`);
  return p;
}
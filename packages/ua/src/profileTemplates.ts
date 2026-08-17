import type { UaTemplate } from './types.js';
import { TEMPLATES } from './templates.js';

const templateIds = new Set(TEMPLATES.map((t) => t.id));

// Maps each existing device profile id → list of UA template ids.
// The five device profile ids match what `packages/profiles` exposes.
export const PROFILE_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  'desktop-windows-chrome': ['windows-chrome-110', 'windows-chrome-118', 'windows-chrome-124', 'windows-edge-124'],
  'desktop-mac-safari': ['mac-safari-15', 'mac-safari-16', 'mac-safari-17', 'mac-chrome-118', 'mac-chrome-124'],
  'iphone-15-safari': ['iphone-15-safari', 'iphone-15-plus-safari', 'iphone-15-pro-safari', 'iphone-15-pro-max-safari', 'iphone-14-pro-safari', 'iphone-se-3-safari'],
  'android-pixel-chrome': ['pixel-7-chrome', 'pixel-8-chrome', 'pixel-8-pro-chrome', 'samsung-s23-chrome', 'samsung-s24-chrome', 'oneplus-11-chrome'],
  'ipad-safari': ['ipad-air-5-safari', 'ipad-pro-11-safari', 'ipad-pro-12-9-safari', 'ipad-mini-6-safari'],
};

export function templatesForProfile(profileId: string): readonly UaTemplate[] {
  const ids = PROFILE_TEMPLATES[profileId];
  if (!ids) throw new Error(`unknown profile id for UA templates: ${profileId}`);
  return ids
    .map((id) => TEMPLATES.find((t) => t.id === id))
    .filter((t): t is UaTemplate => t !== undefined);
}

export function templateById(id: string): UaTemplate {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`unknown UA template id: ${id}`);
  return t;
}

// Internal helper for tests: assert all referenced template ids exist.
export function validateProfileTemplates(): void {
  for (const [profileId, ids] of Object.entries(PROFILE_TEMPLATES)) {
    for (const id of ids) {
      if (!templateIds.has(id)) throw new Error(`profile ${profileId} references unknown template ${id}`);
    }
  }
}
validateProfileTemplates();

export interface BurstProfile {
  target_rps: number;
  duration_seconds: number;
  ramp_seconds: number;
  max_requests: number;
}

export function burstRequestCount(profile: BurstProfile): number {
  const capacity = Math.floor(profile.target_rps * (profile.duration_seconds - profile.ramp_seconds / 2));
  return Math.min(profile.max_requests, Math.max(1, capacity));
}

export function burstOffsetMs(index: number, profile: BurstProfile): number {
  const rampCapacity = profile.target_rps * profile.ramp_seconds / 2;
  const seconds = profile.ramp_seconds > 0 && index < rampCapacity
    ? Math.sqrt((2 * index * profile.ramp_seconds) / profile.target_rps)
    : profile.ramp_seconds + Math.max(0, index - rampCapacity) / profile.target_rps;
  return seconds * 1000;
}

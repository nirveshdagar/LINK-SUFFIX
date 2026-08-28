export function computeCampaignLaunchGapMs(workerCount, spreadMs = 58_000) {
  const workers = Math.max(1, Math.trunc(Number(workerCount) || 1));
  const spread = Math.max(0, Math.trunc(Number(spreadMs) || 0));
  return spread === 0 ? 0 : Math.max(100, Math.ceil(spread / workers));
}

export function evaluateResourceAdmission({
  availableMemoryBytes,
  totalMemoryBytes,
  oneMinuteLoad,
  cpuCount,
  minimumAvailableMemoryRatio = 0.15,
  maximumNormalizedLoad = 1.25,
}) {
  const memoryRatio = totalMemoryBytes > 0 ? availableMemoryBytes / totalMemoryBytes : 1;
  const normalizedLoad = cpuCount > 0 && Number.isFinite(oneMinuteLoad)
    ? oneMinuteLoad / cpuCount
    : 0;
  const reasons = [];
  if (memoryRatio < minimumAvailableMemoryRatio) reasons.push("memory");
  if (normalizedLoad > maximumNormalizedLoad) reasons.push("load");
  return {
    allowed: reasons.length === 0,
    memoryRatio,
    normalizedLoad,
    reasons,
  };
}

export function estimateRemainingSeconds(progress: number | null, elapsedMs: number): number | null {
  if (progress === null || !Number.isFinite(progress) || progress < .05 || progress >= 1 || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  return Math.ceil(elapsedMs / 1000 * (1 - progress) / progress);
}

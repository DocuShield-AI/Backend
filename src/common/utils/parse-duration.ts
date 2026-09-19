const UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/** Parses a duration like "15m", "7d", "2h", "500ms" into seconds. NaN on invalid input. */
export function parseDurationToSeconds(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) {
    return Number.NaN;
  }
  return Number(match[1]) * UNIT_SECONDS[match[2]];
}
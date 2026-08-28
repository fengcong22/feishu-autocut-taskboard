export const ARTIFACT_UPLOAD_LEASE_DURATION_MS = 15 * 60 * 1000;
export const ARTIFACT_UPLOAD_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const ARTIFACT_UPLOAD_MAX_FUTURE_MS = (
  ARTIFACT_UPLOAD_LEASE_DURATION_MS + ARTIFACT_UPLOAD_CLOCK_SKEW_MS
);

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function parseArtifactUploadTimestamp(value) {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return null;
  return timestamp;
}

export function artifactUploadLeaseNeedsRecovery(row, nowMs) {
  const leaseUntilMs = parseArtifactUploadTimestamp(row?.leaseUntil);
  const startedAtMs = parseArtifactUploadTimestamp(row?.startedAt);
  if (typeof row?.claimToken !== "string" || row.claimToken.trim() === "") return true;
  if (leaseUntilMs === null || startedAtMs === null) return true;
  if (leaseUntilMs <= nowMs) return true;
  if (leaseUntilMs > nowMs + ARTIFACT_UPLOAD_MAX_FUTURE_MS) return true;
  const issuedDuration = leaseUntilMs - startedAtMs;
  return issuedDuration <= 0 || issuedDuration > ARTIFACT_UPLOAD_MAX_FUTURE_MS;
}

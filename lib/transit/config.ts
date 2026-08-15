const REQUIRED_VARS = [
  'GTFS_STATIC_URL',
  'GTFS_RT_VEHICLE_POSITIONS_URL',
  'GTFS_RT_TRIP_UPDATES_URL',
  'GTFS_RT_ALERTS_URL',
] as const;

export type TransitConfig = {
  staticUrl: string | null;
  vehiclePositionsUrl: string | null;
  tripUpdatesUrl: string | null;
  alertsUrl: string | null;
  refreshIntervalMs: number;
  historyLoggingEnabled: boolean;
  historyLogDir: string;
  mlArtifactPath: string | null;
  missingVariables: string[];
  configured: boolean;
};

export function getTransitConfig(): TransitConfig {
  const staticUrl = process.env.GTFS_STATIC_URL ?? null;
  const vehiclePositionsUrl = process.env.GTFS_RT_VEHICLE_POSITIONS_URL ?? null;
  const tripUpdatesUrl = process.env.GTFS_RT_TRIP_UPDATES_URL ?? null;
  const alertsUrl = process.env.GTFS_RT_ALERTS_URL ?? null;
  const refreshIntervalMs = Number(process.env.GTFS_REFRESH_INTERVAL_MS ?? '5000');
  const historyLoggingEnabled = process.env.TRANSIT_HISTORY_LOGGING === 'true';
  const historyLogDir = process.env.TRANSIT_HISTORY_LOG_DIR ?? 'data/ml';
  const mlArtifactPath = process.env.TRANSIT_ML_ARTIFACT_PATH ?? null;

  const missingVariables = REQUIRED_VARS.filter((key) => !process.env[key]);

  return {
    staticUrl,
    vehiclePositionsUrl,
    tripUpdatesUrl,
    alertsUrl,
    refreshIntervalMs: Number.isFinite(refreshIntervalMs) ? refreshIntervalMs : 5000,
    historyLoggingEnabled,
    historyLogDir,
    mlArtifactPath,
    missingVariables,
    configured: missingVariables.length === 0,
  };
}

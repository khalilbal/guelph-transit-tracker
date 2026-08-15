import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { getTransitConfig } from '@/lib/transit/config';

export type ArrivalMlFeatures = {
  etaMinutes: number;
  absDelayMinutes: number;
  isRealtime: number;
  hasVehicle: number;
  vehicleStale: number;
  movingNormally: number;
  feedAgeSeconds: number;
  distanceToStopMeters: number;
  stopsAway: number;
  vehicleSpeedKph: number;
  routeActiveVehicles: number;
  routeStaleRatio: number;
  routeAverageDelayMinutes: number;
  alertCount: number;
  stopAlertCount: number;
  routeAlertCount: number;
};

type LogisticArtifact = {
  version: number;
  target: string;
  trainedAt: string;
  featureOrder: Array<keyof ArrivalMlFeatures>;
  intercept: number;
  coefficients: Partial<Record<keyof ArrivalMlFeatures, number>>;
};

type CachedArtifact = {
  mtimeMs: number;
  model: LogisticArtifact | null;
};

export type ArrivalMlPrediction = {
  probability: number;
  score: number;
};

export type ArrivalMlStatus = {
  historyLoggingEnabled: boolean;
  artifactConfigured: boolean;
  artifactLoaded: boolean;
  modelTarget: string | null;
  trainedAt: string | null;
};

let cachedArtifact: CachedArtifact | null = null;

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function loadArtifact(): LogisticArtifact | null {
  const config = getTransitConfig();
  if (!config.mlArtifactPath) {
    return null;
  }

  const artifactPath = path.isAbsolute(config.mlArtifactPath)
    ? config.mlArtifactPath
    : path.join(process.cwd(), config.mlArtifactPath);

  try {
    const stats = statSync(artifactPath);
    if (cachedArtifact && cachedArtifact.mtimeMs === stats.mtimeMs) {
      return cachedArtifact.model;
    }

    const parsed = JSON.parse(readFileSync(artifactPath, 'utf8')) as LogisticArtifact;
    cachedArtifact = {
      mtimeMs: stats.mtimeMs,
      model: parsed,
    };
    return parsed;
  } catch {
    cachedArtifact = {
      mtimeMs: 0,
      model: null,
    };
    return null;
  }
}

export function predictArrivalReliability(features: ArrivalMlFeatures): ArrivalMlPrediction | null {
  const artifact = loadArtifact();
  if (!artifact) {
    return null;
  }

  let linear = artifact.intercept;
  artifact.featureOrder.forEach((featureName) => {
    linear += (artifact.coefficients[featureName] ?? 0) * features[featureName];
  });

  const probability = sigmoid(linear);
  return {
    probability,
    score: Math.max(0, Math.min(100, Math.round(probability * 100))),
  };
}

export function getArrivalMlStatus(): ArrivalMlStatus {
  const config = getTransitConfig();
  const artifact = loadArtifact();

  return {
    historyLoggingEnabled: config.historyLoggingEnabled,
    artifactConfigured: Boolean(config.mlArtifactPath),
    artifactLoaded: Boolean(artifact),
    modelTarget: artifact?.target ?? null,
    trainedAt: artifact?.trainedAt ?? null,
  };
}

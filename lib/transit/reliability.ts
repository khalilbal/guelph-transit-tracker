import { haversineMeters } from '@/lib/transit/geo';
import { ArrivalMlFeatures, predictArrivalReliability } from '@/lib/transit/ml';
import {
  ArrivalConfidenceLevel,
  ArrivalRecommendation,
  TransitAlert,
  TransitArrival,
  TransitStop,
  TransitVehicle,
} from '@/lib/transit/types';

type VehicleMovementSnapshot = {
  lat: number;
  lng: number;
  lastSeenMs: number;
  stationarySinceMs: number;
  stopSequence: number | null;
};

type VehicleMovementInsight = {
  movingNormally: boolean;
  stationaryDurationMs: number;
};

type ScoredArrival = TransitArrival & {
  confidenceScore: number;
  confidenceLevel: ArrivalConfidenceLevel;
  recommendation: ArrivalRecommendation;
  reasons: string[];
};

type ScoreArrivalParams = {
  arrival: Omit<TransitArrival, 'confidenceScore' | 'confidenceLevel' | 'recommendation' | 'reasons'>;
  stop: TransitStop;
  vehicle: TransitVehicle | null;
  movementInsight: VehicleMovementInsight | null;
  routeVehicles: TransitVehicle[];
  alerts: TransitAlert[];
  feedTimestampMs: number | null;
  refreshIntervalMs: number;
  nowMs: number;
};

const vehicleMovementHistory = new Map<string, VehicleMovementSnapshot>();
const MOVED_DISTANCE_METERS = 35;
const STATIONARY_WARNING_MS = 3 * 60 * 1000;

function confidenceLevel(score: number): ArrivalConfidenceLevel {
  if (score >= 90) {
    return 'HIGH';
  }
  if (score >= 70) {
    return 'MEDIUM';
  }
  return 'LOW';
}

function computeRecommendationScore(arrival: ScoredArrival) {
  return arrival.confidenceScore - Math.max(arrival.etaMinutes, 0) * 2.25 - Math.max(Math.abs(arrival.delaySeconds) / 60 - 4, 0) * 3;
}

function uniqueReasons(reasons: string[]) {
  return Array.from(new Set(reasons)).slice(0, 4);
}

function routeHealthScore(routeVehicles: TransitVehicle[]) {
  if (!routeVehicles.length) {
    return {
      points: 2,
      reason: 'no live vehicles are visible on this route yet',
    };
  }

  const staleVehicles = routeVehicles.filter((vehicle) => vehicle.isStale).length;
  const averageDelayMinutes =
    routeVehicles.reduce((sum, vehicle) => sum + Math.abs((vehicle.delaySeconds ?? 0) / 60), 0) / routeVehicles.length;
  const staleRatio = staleVehicles / routeVehicles.length;

  if (averageDelayMinutes <= 2 && staleRatio === 0) {
    return {
      points: 10,
      reason: 'route currently operating normally',
    };
  }

  if (averageDelayMinutes <= 6 && staleRatio <= 0.4) {
    return {
      points: 6,
      reason: 'route has minor delay risk right now',
    };
  }

  return {
    points: 2,
    reason: 'route is seeing delay or stale-tracking issues',
  };
}

function proximityScore(stop: TransitStop, vehicle: TransitVehicle | null, arrival: Pick<TransitArrival, 'stopsAway'>) {
  if (vehicle) {
    const distanceMeters = haversineMeters(stop.lat, stop.lng, vehicle.lat, vehicle.lng);
    if (distanceMeters <= 250) {
      return { points: 10, reason: 'vehicle is already very close to the stop' };
    }
    if (distanceMeters <= 700) {
      return { points: 7, reason: 'vehicle is approaching the stop' };
    }
    if (distanceMeters <= 1500) {
      return { points: 4, reason: 'vehicle is still some distance away' };
    }
    return { points: 1, reason: 'vehicle is still far from the stop' };
  }

  if (arrival.stopsAway !== null) {
    if (arrival.stopsAway <= 1) {
      return { points: 8, reason: 'bus is one stop away' };
    }
    if (arrival.stopsAway <= 3) {
      return { points: 5, reason: `${arrival.stopsAway} stops remain before this stop` };
    }
  }

  return { points: 0, reason: 'vehicle proximity is not visible in the live feed' };
}

function alertScore(alerts: TransitAlert[], arrival: Pick<TransitArrival, 'routeId' | 'stopId'>) {
  const impactingAlerts = alerts.filter((alert) => {
    const routeHit = alert.routeIds.includes(arrival.routeId);
    const stopHit = alert.stopIds.includes(arrival.stopId);
    return routeHit || stopHit;
  });

  if (!impactingAlerts.length) {
    return {
      points: 15,
      reason: 'no service alerts affect this trip',
    };
  }

  const hasStopSpecificAlert = impactingAlerts.some((alert) => alert.stopIds.includes(arrival.stopId));
  return {
    points: hasStopSpecificAlert ? 0 : 4,
    reason: hasStopSpecificAlert ? 'stop-specific service alert may affect this trip' : 'route alert may affect this trip',
  };
}

function clampNonNegative(value: number | null | undefined) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Number(value));
}

function buildArrivalMlFeatures(params: ScoreArrivalParams): ArrivalMlFeatures {
  const { arrival, stop, vehicle, movementInsight, routeVehicles, alerts, feedTimestampMs, nowMs } = params;
  const distanceToStopMeters = vehicle ? haversineMeters(stop.lat, stop.lng, vehicle.lat, vehicle.lng) : 0;
  const routeStaleVehicles = routeVehicles.filter((candidate) => candidate.isStale).length;
  const routeAverageDelayMinutes = routeVehicles.length
    ? routeVehicles.reduce((sum, candidate) => sum + Math.abs((candidate.delaySeconds ?? 0) / 60), 0) / routeVehicles.length
    : 0;
  const freshnessReferenceMs =
    (vehicle?.lastUpdated ? new Date(vehicle.lastUpdated).getTime() : null) ?? feedTimestampMs ?? nowMs;

  return {
    etaMinutes: clampNonNegative(arrival.etaMinutes),
    absDelayMinutes: clampNonNegative(Math.abs(arrival.delaySeconds) / 60),
    isRealtime: arrival.isRealtime ? 1 : 0,
    hasVehicle: vehicle ? 1 : 0,
    vehicleStale: vehicle?.isStale ? 1 : 0,
    movingNormally: movementInsight?.movingNormally ? 1 : 0,
    feedAgeSeconds: clampNonNegative((nowMs - freshnessReferenceMs) / 1000),
    distanceToStopMeters: clampNonNegative(distanceToStopMeters),
    stopsAway: clampNonNegative(arrival.stopsAway),
    vehicleSpeedKph: clampNonNegative(vehicle?.speedKph),
    routeActiveVehicles: clampNonNegative(routeVehicles.length),
    routeStaleRatio: routeVehicles.length ? routeStaleVehicles / routeVehicles.length : 0,
    routeAverageDelayMinutes: clampNonNegative(routeAverageDelayMinutes),
    alertCount: alerts.filter((alert) => alert.routeIds.includes(arrival.routeId) || alert.stopIds.includes(arrival.stopId)).length,
    stopAlertCount: alerts.filter((alert) => alert.stopIds.includes(arrival.stopId)).length,
    routeAlertCount: alerts.filter((alert) => alert.routeIds.includes(arrival.routeId)).length,
  };
}

export function buildVehicleMovementIndex(vehicles: TransitVehicle[], nowMs: number) {
  const movementByVehicleId = new Map<string, VehicleMovementInsight>();

  vehicles.forEach((vehicle) => {
    const previous = vehicleMovementHistory.get(vehicle.id);
    let stationarySinceMs = nowMs;

    if (previous) {
      const movedDistance = haversineMeters(previous.lat, previous.lng, vehicle.lat, vehicle.lng);
      const sequenceAdvanced =
        vehicle.currentStopSequence !== null &&
        previous.stopSequence !== null &&
        vehicle.currentStopSequence > previous.stopSequence;
      const speedMoving = (vehicle.speedKph ?? 0) >= 4;

      stationarySinceMs =
        movedDistance > MOVED_DISTANCE_METERS || sequenceAdvanced || speedMoving
          ? nowMs
          : previous.stationarySinceMs;
    }

    const snapshot: VehicleMovementSnapshot = {
      lat: vehicle.lat,
      lng: vehicle.lng,
      lastSeenMs: nowMs,
      stationarySinceMs,
      stopSequence: vehicle.currentStopSequence,
    };

    vehicleMovementHistory.set(vehicle.id, snapshot);

    const stationaryDurationMs = nowMs - stationarySinceMs;
    const movingNormally =
      !vehicle.isStale &&
      ((vehicle.speedKph ?? 0) >= 4 ||
        vehicle.status === 'IN_TRANSIT_TO' ||
        stationaryDurationMs < STATIONARY_WARNING_MS);

    movementByVehicleId.set(vehicle.id, {
      movingNormally,
      stationaryDurationMs,
    });
  });

  return movementByVehicleId;
}

export function scoreArrivalReliability(params: ScoreArrivalParams) {
  const {
    arrival,
    stop,
    vehicle,
    movementInsight,
    routeVehicles,
    alerts,
    feedTimestampMs,
    refreshIntervalMs,
    nowMs,
  } = params;

  let score = 0;
  const reasons: string[] = [];

  if (vehicle && !vehicle.isStale) {
    score += 20;
    reasons.push('vehicle live in the feed');
  } else if (arrival.isRealtime) {
    score += 8;
    reasons.push('trip update is live, but no fresh vehicle position is exposed');
  } else {
    reasons.push('realtime vehicle data is missing for this trip');
  }

  const absoluteDelayMinutes = Math.abs(arrival.delaySeconds) / 60;
  if (absoluteDelayMinutes < 2) {
    score += 20;
    reasons.push('prediction is close to schedule');
  } else if (absoluteDelayMinutes < 5) {
    score += 12;
    reasons.push('delay is still moderate');
  } else if (absoluteDelayMinutes < 10) {
    score += 5;
    reasons.push('delay is noticeable');
  } else {
    reasons.push('delay is high enough that waiting may be safer');
  }

  const alert = alertScore(alerts, arrival);
  score += alert.points;
  reasons.push(alert.reason);

  if (movementInsight?.movingNormally) {
    score += 15;
    reasons.push('vehicle live and moving');
  } else if (vehicle && !vehicle.isStale) {
    score += 4;
    reasons.push(
      movementInsight && movementInsight.stationaryDurationMs >= STATIONARY_WARNING_MS
        ? 'vehicle has been stationary for several minutes'
        : 'vehicle movement is unclear',
    );
  } else {
    reasons.push('vehicle movement cannot be confirmed');
  }

  const freshnessReferenceMs =
    (vehicle?.lastUpdated ? new Date(vehicle.lastUpdated).getTime() : null) ?? feedTimestampMs;
  const feedAgeMs = freshnessReferenceMs ? nowMs - freshnessReferenceMs : Number.POSITIVE_INFINITY;
  if (feedAgeMs <= refreshIntervalMs * 1.5) {
    score += 10;
    reasons.push('feed is fresh');
  } else if (feedAgeMs <= refreshIntervalMs * 3) {
    score += 5;
    reasons.push('feed is slightly behind but still usable');
  } else {
    reasons.push('feed freshness is weak');
  }

  const proximity = proximityScore(stop, vehicle, arrival);
  score += proximity.points;
  reasons.push(proximity.reason);

  const routeHealth = routeHealthScore(routeVehicles);
  score += routeHealth.points;
  reasons.push(routeHealth.reason);

  const features = buildArrivalMlFeatures(params);
  const mlPrediction = predictArrivalReliability(features);
  if (mlPrediction) {
    score = Math.round(score * 0.7 + mlPrediction.score * 0.3);
    reasons.push(
      mlPrediction.probability >= 0.75
        ? 'historical model also rates this departure as stable'
        : mlPrediction.probability <= 0.4
          ? 'historical model sees elevated ETA risk on similar trips'
          : 'historical model sees moderate confidence on similar trips',
    );
  }

  const confidenceScore = Math.max(0, Math.min(100, Math.round(score)));
  const level = confidenceLevel(confidenceScore);

  return {
    features,
    confidenceScore,
    confidenceLevel: level,
    recommendation: 'consider' as ArrivalRecommendation,
    reasons: uniqueReasons(reasons),
  };
}

export function rankArrivalRecommendations(arrivals: ScoredArrival[]) {
  const ranked = [...arrivals]
    .sort((left, right) => {
      const scoreDelta = computeRecommendationScore(right) - computeRecommendationScore(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return new Date(left.estimatedDeparture).getTime() - new Date(right.estimatedDeparture).getTime();
    })
    .map((arrival, index, sorted) => {
      const leader = sorted[0];
      const leaderScore = computeRecommendationScore(leader);
      const currentScore = computeRecommendationScore(arrival);
      const withinReach = leaderScore - currentScore <= 8;

      let recommendation: ArrivalRecommendation = 'wait';
      if (index === 0 && (arrival.confidenceScore >= 70 || withinReach)) {
        recommendation = 'recommended';
      } else if (withinReach && arrival.confidenceScore >= 60) {
        recommendation = 'consider';
      }

      return {
        ...arrival,
        recommendation,
      };
    });

  return ranked;
}

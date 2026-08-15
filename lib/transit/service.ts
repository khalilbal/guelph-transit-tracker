import { getTransitConfig } from '@/lib/transit/config';
import { haversineMeters } from '@/lib/transit/geo';
import { loadRealtimeFeeds } from '@/lib/transit/gtfs-rt';
import { loadStaticGtfs } from '@/lib/transit/gtfs-static';
import { logArrivalSnapshots } from '@/lib/transit/history';
import { getArrivalMlStatus } from '@/lib/transit/ml';
import { buildVehicleMovementIndex, rankArrivalRecommendations, scoreArrivalReliability } from '@/lib/transit/reliability';
import { formatIso, formatSecondsToLocalIso, getServiceContext } from '@/lib/transit/time';
import {
  AddressResolvedStop,
  CommuteOption,
  JourneyOption,
  JourneyLeg,
  JourneyPlanResponse,
  NearbyResponse,
  NearbyStop,
  NearbyTransit,
  NearbyVehicle,
  RealtimeDataset,
  RealtimeStopTimeUpdate,
  RouteResponse,
  RoutePreview,
  StaticDataset,
  StopArrivalsResponse,
  StopSearchResponse,
  TransitAlert,
  TransitApiResponse,
  TransitArrival,
  TransitMeta,
  TransitRoute,
  TransitStop,
  TransitVehicle,
  VehicleResponse,
} from '@/lib/transit/types';

type CacheState<T> = {
  value: T | null;
  fetchedAt: number | null;
  error: string | null;
  promise: Promise<T> | null;
};

const STATIC_TTL_MS = 1000 * 60 * 60 * 12;

function createCache<T>(): CacheState<T> {
  return {
    value: null,
    fetchedAt: null,
    error: null,
    promise: null,
  };
}

function normalizeColor(input: string | null | undefined, fallback: string) {
  const value = (input || '').trim();
  if (!value) {
    return fallback;
  }
  return value.startsWith('#') ? value : `#${value}`;
}

function buildMeta(params: {
  staticCache: CacheState<StaticDataset>;
  realtimeCache: CacheState<RealtimeDataset>;
}): TransitMeta {
  const config = getTransitConfig();
  const refreshedAt = params.realtimeCache.fetchedAt ?? params.staticCache.fetchedAt;
  const warnings: string[] = [];
  const errors: string[] = [];

  if (params.staticCache.error) {
    errors.push(`Static GTFS: ${params.staticCache.error}`);
  }
  if (params.realtimeCache.error) {
    errors.push(`Realtime feeds: ${params.realtimeCache.error}`);
  }
  if (!config.configured) {
    warnings.push('Feed URLs are not configured. Add the official City of Guelph URLs to your environment variables.');
  }
  if (params.realtimeCache.fetchedAt && Date.now() - params.realtimeCache.fetchedAt > config.refreshIntervalMs * 2.5) {
    warnings.push('Realtime data is stale. The UI may be showing the last successful refresh.');
  }
  const ml = getArrivalMlStatus();
  if (ml.historyLoggingEnabled && !ml.artifactLoaded) {
    warnings.push('ML snapshot logging is enabled, but no trained model artifact is loaded yet.');
  }

  return {
    configured: config.configured,
    missingVariables: config.missingVariables,
    refreshedAt: formatIso(refreshedAt),
    staticLoadedAt: formatIso(params.staticCache.fetchedAt),
    stale: Boolean(params.realtimeCache.fetchedAt && Date.now() - params.realtimeCache.fetchedAt > config.refreshIntervalMs * 2.5),
    ml,
    warnings,
    errors,
  };
}

function compareSortKey(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toString().padStart(4, '0') : value;
}

function activeServiceIds(staticData: StaticDataset, dateKey: string, weekday: number) {
  const active = new Set<string>();

  staticData.calendars.forEach((calendar) => {
    if (dateKey < calendar.startDate || dateKey > calendar.endDate) {
      return;
    }
    if (calendar.activeWeekdays.has(weekday)) {
      active.add(calendar.serviceId);
    }
  });

  staticData.calendarExceptions.forEach((exception) => {
    if (exception.date !== dateKey) {
      return;
    }
    if (exception.exceptionType === 1) {
      active.add(exception.serviceId);
    }
    if (exception.exceptionType === 2) {
      active.delete(exception.serviceId);
    }
  });

  return active;
}

function stopToPublic(stop: StaticDataset['stopsById'] extends Map<string, infer T> ? T : never, routeIds: string[] = []): TransitStop {
  return {
    id: stop.stopId,
    code: stop.stopCode,
    name: stop.stopName,
    lat: stop.stopLat,
    lng: stop.stopLng,
    wheelchairBoarding: stop.wheelchairBoarding,
    routeIds,
  };
}

function findStopUpdate(stopUpdates: RealtimeStopTimeUpdate[], stopId: string, stopSequence: number) {
  return (
    stopUpdates.find((update) => update.stopSequence === stopSequence && update.stopId === stopId) ||
    stopUpdates.find((update) => update.stopSequence === stopSequence) ||
    stopUpdates.find((update) => update.stopId === stopId) ||
    null
  );
}

function shapePointsForTrip(staticData: StaticDataset, tripId: string) {
  const trip = staticData.tripsById.get(tripId);
  if (!trip?.shapeId) {
    return [];
  }

  return (staticData.shapesById.get(trip.shapeId) ?? []).map((point) => ({
    lat: point.lat,
    lng: point.lng,
  }));
}

function shapePathsForRoute(staticData: StaticDataset, routeId: string) {
  const uniqueShapeIds = new Set<string>();
  const shapePaths: Array<Array<{ lat: number; lng: number }>> = [];

  for (const trip of staticData.tripsById.values()) {
    if (trip.routeId !== routeId || !trip.shapeId || uniqueShapeIds.has(trip.shapeId)) {
      continue;
    }

    uniqueShapeIds.add(trip.shapeId);
    const path = (staticData.shapesById.get(trip.shapeId) ?? []).map((point) => ({
      lat: point.lat,
      lng: point.lng,
    }));

    if (path.length > 1) {
      shapePaths.push(path);
    }
  }

  return shapePaths.sort((a, b) => b.length - a.length);
}

function minutesBetween(startIso: string, endIso: string) {
  return Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
}

function recommendationWeight(value: { recommendation: 'recommended' | 'consider' | 'wait' }) {
  return value.recommendation === 'recommended' ? 0 : value.recommendation === 'consider' ? 1 : 2;
}

class TransitService {
  private staticCache = createCache<StaticDataset>();
  private realtimeCache = createCache<RealtimeDataset>();

  private async ensureStaticData() {
    const config = getTransitConfig();
    if (!config.staticUrl) {
      return null;
    }

    const isFresh = this.staticCache.value && this.staticCache.fetchedAt && Date.now() - this.staticCache.fetchedAt < STATIC_TTL_MS;
    if (isFresh) {
      return this.staticCache.value;
    }
    if (this.staticCache.promise) {
      return this.staticCache.promise;
    }

    this.staticCache.promise = loadStaticGtfs(config.staticUrl)
      .then((value) => {
        this.staticCache.value = value;
        this.staticCache.fetchedAt = Date.now();
        this.staticCache.error = null;
        return value;
      })
      .catch((error: Error) => {
        this.staticCache.error = error.message;
        if (this.staticCache.value) {
          return this.staticCache.value;
        }
        throw error;
      })
      .finally(() => {
        this.staticCache.promise = null;
      });

    return this.staticCache.promise;
  }

  private async ensureRealtimeData() {
    const config = getTransitConfig();
    if (!config.vehiclePositionsUrl || !config.tripUpdatesUrl || !config.alertsUrl) {
      return null;
    }

    const isFresh =
      this.realtimeCache.value &&
      this.realtimeCache.fetchedAt &&
      Date.now() - this.realtimeCache.fetchedAt < config.refreshIntervalMs;

    if (isFresh) {
      return this.realtimeCache.value;
    }
    if (this.realtimeCache.promise) {
      return this.realtimeCache.promise;
    }

    this.realtimeCache.promise = loadRealtimeFeeds({
      vehiclesUrl: config.vehiclePositionsUrl,
      tripUpdatesUrl: config.tripUpdatesUrl,
      alertsUrl: config.alertsUrl,
    })
      .then((value) => {
        this.realtimeCache.value = value;
        this.realtimeCache.fetchedAt = Date.now();
        this.realtimeCache.error = null;
        return value;
      })
      .catch((error: Error) => {
        this.realtimeCache.error = error.message;
        if (this.realtimeCache.value) {
          return this.realtimeCache.value;
        }
        throw error;
      })
      .finally(() => {
        this.realtimeCache.promise = null;
      });

    return this.realtimeCache.promise;
  }

  private async getDatasets() {
    const [staticData, realtimeData] = await Promise.all([
      this.ensureStaticData(),
      this.ensureRealtimeData(),
    ]);

    return {
      staticData,
      realtimeData,
      meta: buildMeta({
        staticCache: this.staticCache,
        realtimeCache: this.realtimeCache,
      }),
    };
  }

  private buildVehicles(staticData: StaticDataset | null, realtimeData: RealtimeDataset | null): TransitVehicle[] {
    if (!realtimeData) {
      return [];
    }

    const now = Date.now();
    const config = getTransitConfig();

    return realtimeData.vehicles
      .map((vehicle) => {
        const trip = vehicle.tripId && staticData ? staticData.tripsById.get(vehicle.tripId) : null;
        const routeId = vehicle.routeId || trip?.routeId || null;
        const route = routeId && staticData ? staticData.routesById.get(routeId) : null;
        const tripUpdate = vehicle.tripId ? realtimeData.tripUpdates.get(vehicle.tripId) : null;
        const stopTimes = vehicle.tripId && staticData ? staticData.stopTimesByTripId.get(vehicle.tripId) ?? [] : [];

        const futureStopTimes = stopTimes.filter((entry) => {
          if (vehicle.currentStopSequence === null) {
            return entry.departureSeconds >= getServiceContext().secondsSinceMidnight;
          }
          return entry.stopSequence > vehicle.currentStopSequence;
        });

        const futureUpdates = (tripUpdate?.stopTimeUpdates ?? [])
          .filter((update) => {
            if (vehicle.currentStopSequence === null || update.stopSequence === null) {
              return true;
            }
            return update.stopSequence > vehicle.currentStopSequence;
          })
          .sort((a, b) => (a.stopSequence ?? Number.MAX_SAFE_INTEGER) - (b.stopSequence ?? Number.MAX_SAFE_INTEGER));

        const nextStops = (futureUpdates.length > 0 ? futureUpdates : futureStopTimes)
          .slice(0, 3)
          .map((entry) => {
            const stopId = entry.stopId;
            const sequence = entry.stopSequence ?? null;
            const stop = stopId && staticData ? staticData.stopsById.get(stopId) : null;
            const arrivalTime =
              'arrivalTimeMs' in entry
                ? formatIso(entry.arrivalTimeMs ?? entry.departureTimeMs)
                : formatSecondsToLocalIso(new Date(), entry.arrivalSeconds);

            return stop && sequence && stopId
              ? {
                  id: stopId,
                  name: stop.stopName,
                  sequence,
                  arrivalTime,
                }
              : null;
          })
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

        const nextStop = nextStops[0] ?? null;
        const delaySeconds = tripUpdate?.delaySeconds ?? futureUpdates[0]?.delaySeconds ?? null;
        const isStale = vehicle.timestampMs ? now - vehicle.timestampMs > config.refreshIntervalMs * 2.5 : true;

        return {
          id: vehicle.id,
          label: vehicle.label,
          tripId: vehicle.tripId,
          routeId,
          routeShortName: route?.routeShortName || routeId || 'Route',
          routeColor: normalizeColor(route?.routeColor, '#0A9396'),
          routeTextColor: normalizeColor(route?.routeTextColor, '#FFFFFF'),
          headsign: trip?.tripHeadsign || route?.routeLongName || 'In service',
          lat: vehicle.lat,
          lng: vehicle.lng,
          bearing: vehicle.bearing,
          speedKph: vehicle.speedKph,
          lastUpdated: formatIso(vehicle.timestampMs ?? realtimeData.feedTimestampMs),
          isStale,
          status: vehicle.status,
          currentStopSequence: vehicle.currentStopSequence,
          delaySeconds,
          nextStopId: nextStop?.id ?? null,
          nextStopName: nextStop?.name ?? null,
          nextStops,
        } satisfies TransitVehicle;
      })
      .sort((a, b) => {
        if (a.isStale !== b.isStale) {
          return Number(a.isStale) - Number(b.isStale);
        }
        return a.routeShortName.localeCompare(b.routeShortName, undefined, { numeric: true });
      });
  }

  private buildRoutes(staticData: StaticDataset | null, vehicles: TransitVehicle[]): TransitRoute[] {
    if (!staticData) {
      return [];
    }

    const shapePathsByRouteId = new Map<string, Array<Array<{ lat: number; lng: number }>>>();
    for (const route of staticData.routesById.values()) {
      shapePathsByRouteId.set(route.routeId, shapePathsForRoute(staticData, route.routeId));
    }

    return Array.from(staticData.routesById.values())
      .map((route) => {
        const routeVehicles = vehicles.filter((vehicle) => vehicle.routeId === route.routeId);
        const activeVehicles = routeVehicles.length;
        const staleVehicles = routeVehicles.filter((vehicle) => vehicle.isStale).length;
        const delayValues = routeVehicles
          .map((vehicle) => Math.abs((vehicle.delaySeconds ?? 0) / 60))
          .filter((value) => Number.isFinite(value));
        const averageDelayMinutes = delayValues.length
          ? delayValues.reduce((sum, value) => sum + value, 0) / delayValues.length
          : 0;

        let status: TransitRoute['reliability']['status'] = 'scheduled-only';
        if (activeVehicles > 0 && averageDelayMinutes <= 2 && staleVehicles === 0) {
          status = 'strong';
        } else if (activeVehicles > 0 && averageDelayMinutes <= 6) {
          status = 'watch';
        } else if (activeVehicles > 0) {
          status = 'disrupted';
        }

        return {
          id: route.routeId,
          shortName: route.routeShortName,
          longName: route.routeLongName,
          color: normalizeColor(route.routeColor, '#0A9396'),
          textColor: normalizeColor(route.routeTextColor, '#FFFFFF'),
          type: route.routeType,
          sortKey: compareSortKey(route.routeShortName),
          shapePaths: shapePathsByRouteId.get(route.routeId) ?? [],
          reliability: {
            averageDelayMinutes: Number(averageDelayMinutes.toFixed(1)),
            activeVehicles,
            staleVehicles,
            status,
          },
        } satisfies TransitRoute;
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey, undefined, { numeric: true }));
  }

  private buildArrivals(
    staticData: StaticDataset | null,
    realtimeData: RealtimeDataset | null,
    stopId: string,
    destinationStopId?: string,
  ): StopArrivalsResponse {
    if (!staticData) {
      return {
        stop: null,
        arrivals: [],
        bestForDestination: null,
        suggestedOptions: [],
        routePreviews: [],
      };
    }

    const stop = staticData.stopsById.get(stopId);
    if (!stop) {
      return {
        stop: null,
        arrivals: [],
        bestForDestination: null,
        suggestedOptions: [],
        routePreviews: [],
      };
    }

    const service = getServiceContext();
    const activeServices = activeServiceIds(staticData, service.dateKey, service.weekday);
    const nowMs = Date.now();
    const vehicles = this.buildVehicles(staticData, realtimeData);
    const vehicleByTripId = new Map<string, TransitVehicle>(
      vehicles
        .filter((vehicle) => vehicle.tripId)
        .map((vehicle) => [vehicle.tripId as string, vehicle]),
    );
    const movementByVehicleId = buildVehicleMovementIndex(vehicles, nowMs);
    const routeVehiclesByRouteId = new Map<string, TransitVehicle[]>();
    vehicles.forEach((vehicle) => {
      if (!vehicle.routeId) {
        return;
      }
      const entries = routeVehiclesByRouteId.get(vehicle.routeId) ?? [];
      entries.push(vehicle);
      routeVehiclesByRouteId.set(vehicle.routeId, entries);
    });
    const alerts = realtimeData?.alerts ?? [];

    const stopTimes = staticData.stopTimesByStopId.get(stopId) ?? [];
    const arrivalFeaturesByKey = new Map<string, ReturnType<typeof scoreArrivalReliability>['features']>();

    const arrivals = rankArrivalRecommendations(
      stopTimes
      .filter((stopTime) => {
        const trip = staticData.tripsById.get(stopTime.tripId);
        if (!trip) {
          return false;
        }
        if (activeServices.size > 0 && !activeServices.has(trip.serviceId)) {
          return false;
        }
        return stopTime.departureSeconds >= service.secondsSinceMidnight - 300 && stopTime.departureSeconds <= service.secondsSinceMidnight + 3 * 3600;
      })
      .map((stopTime) => {
        const trip = staticData.tripsById.get(stopTime.tripId);
        if (!trip) {
          return null;
        }
        const route = staticData.routesById.get(trip.routeId);
        const tripUpdate = realtimeData?.tripUpdates.get(stopTime.tripId) ?? null;
        const stopUpdate = tripUpdate ? findStopUpdate(tripUpdate.stopTimeUpdates, stopId, stopTime.stopSequence) : null;
        const vehicle = vehicleByTripId.get(stopTime.tripId) ?? null;

        const scheduledDeparture = formatSecondsToLocalIso(new Date(), stopTime.departureSeconds);
        const scheduledDepartureMs = new Date(scheduledDeparture).getTime();
        const realtimeDepartureMs =
          stopUpdate?.departureTimeMs ??
          stopUpdate?.arrivalTimeMs ??
          (tripUpdate?.delaySeconds ? scheduledDepartureMs + tripUpdate.delaySeconds * 1000 : null);
        const estimatedDeparture = realtimeDepartureMs ? new Date(realtimeDepartureMs).toISOString() : scheduledDeparture;
        const delaySeconds = stopUpdate?.delaySeconds ?? tripUpdate?.delaySeconds ?? (realtimeDepartureMs ? Math.round((realtimeDepartureMs - scheduledDepartureMs) / 1000) : 0);

        const destinationStopTime = destinationStopId
          ? (staticData.stopTimesByTripId.get(stopTime.tripId) ?? []).find(
              (candidate) => candidate.stopId === destinationStopId && candidate.stopSequence > stopTime.stopSequence,
            )
          : null;

        const destinationUpdate =
          destinationStopTime && tripUpdate
            ? findStopUpdate(tripUpdate.stopTimeUpdates, destinationStopTime.stopId, destinationStopTime.stopSequence)
            : null;
        const arrivalTimeToDestination = destinationStopTime
          ? destinationUpdate?.arrivalTimeMs
            ? new Date(destinationUpdate.arrivalTimeMs).toISOString()
            : formatSecondsToLocalIso(new Date(), destinationStopTime.arrivalSeconds)
          : null;

        const travelTimeToDestinationMinutes =
          destinationStopTime && arrivalTimeToDestination
            ? Math.max(0, Math.round((new Date(arrivalTimeToDestination).getTime() - new Date(estimatedDeparture).getTime()) / 60000))
            : null;

        const stopsAway =
          vehicle?.currentStopSequence !== null && vehicle?.currentStopSequence !== undefined
            ? Math.max(stopTime.stopSequence - (vehicle.currentStopSequence ?? 0), 0)
            : null;

        const etaMinutes = Math.max(-1, Math.round((new Date(estimatedDeparture).getTime() - nowMs) / 60000));
        const status: TransitArrival['status'] = !tripUpdate
          ? 'scheduled'
          : delaySeconds >= 180
            ? 'delayed'
            : delaySeconds <= -120
              ? 'early'
              : 'on-time';
        const baseArrival = {
          stopId,
          tripId: stopTime.tripId,
          routeId: trip.routeId,
          routeShortName: route?.routeShortName || trip.routeId,
          routeColor: normalizeColor(route?.routeColor, '#0A9396'),
          routeTextColor: normalizeColor(route?.routeTextColor, '#FFFFFF'),
          headsign: trip.tripHeadsign || route?.routeLongName || 'Scheduled trip',
          directionId: trip.directionId,
          scheduledDeparture,
          estimatedDeparture,
          etaMinutes,
          delaySeconds,
          status,
          isRealtime: Boolean(tripUpdate),
          vehicleId: vehicle?.id ?? tripUpdate?.vehicleId ?? null,
          vehicleLabel: vehicle?.label ?? tripUpdate?.vehicleLabel ?? null,
          stopsAway,
          destinationReachable: Boolean(destinationStopTime),
          travelTimeToDestinationMinutes,
        };

        const reliability = scoreArrivalReliability({
          arrival: baseArrival,
          stop: stopToPublic(stop, Array.from(staticData.stopRouteIds.get(stopId) ?? [])),
          vehicle,
          movementInsight: vehicle ? movementByVehicleId.get(vehicle.id) ?? null : null,
          routeVehicles: routeVehiclesByRouteId.get(trip.routeId) ?? [],
          alerts,
          feedTimestampMs: realtimeData?.feedTimestampMs ?? null,
          refreshIntervalMs: getTransitConfig().refreshIntervalMs,
          nowMs,
        });

        const arrival = {
          ...baseArrival,
          confidenceScore: reliability.confidenceScore,
          confidenceLevel: reliability.confidenceLevel,
          recommendation: reliability.recommendation,
          reasons: reliability.reasons,
        } satisfies TransitArrival;

        arrivalFeaturesByKey.set(`${baseArrival.tripId}:${baseArrival.stopId}:${baseArrival.scheduledDeparture}`, reliability.features);

        return arrival;
      })
      .filter((entry): entry is TransitArrival => Boolean(entry))
      .slice(0, 16),
    );

    logArrivalSnapshots(
      arrivals.map((arrival) => ({
        observedAt: new Date(nowMs).toISOString(),
        stopId: arrival.stopId,
        routeId: arrival.routeId,
        tripId: arrival.tripId,
        vehicleId: arrival.vehicleId,
        scheduledDeparture: arrival.scheduledDeparture,
        estimatedDeparture: arrival.estimatedDeparture,
        etaMinutes: arrival.etaMinutes,
        delaySeconds: arrival.delaySeconds,
        confidenceScore: arrival.confidenceScore,
        confidenceLevel: arrival.confidenceLevel,
        recommendation: arrival.recommendation,
        features: arrivalFeaturesByKey.get(`${arrival.tripId}:${arrival.stopId}:${arrival.scheduledDeparture}`) ?? {
          etaMinutes: Math.max(arrival.etaMinutes, 0),
          absDelayMinutes: Math.abs(arrival.delaySeconds) / 60,
          isRealtime: arrival.isRealtime ? 1 : 0,
          hasVehicle: arrival.vehicleId ? 1 : 0,
          vehicleStale: 0,
          movingNormally: 0,
          feedAgeSeconds: 0,
          distanceToStopMeters: 0,
          stopsAway: Math.max(arrival.stopsAway ?? 0, 0),
          vehicleSpeedKph: 0,
          routeActiveVehicles: 0,
          routeStaleRatio: 0,
          routeAverageDelayMinutes: 0,
          alertCount: 0,
          stopAlertCount: 0,
          routeAlertCount: 0,
        },
      })),
    );

    const suggestedOptions = destinationStopId
      ? arrivals
          .filter((arrival) => arrival.destinationReachable)
          .map((arrival) => ({
            routeId: arrival.routeId,
            routeShortName: arrival.routeShortName,
            routeColor: arrival.routeColor,
            routeTextColor: arrival.routeTextColor,
            headsign: arrival.headsign,
            originStopId: stopId,
            destinationStopId,
            departureTime: arrival.estimatedDeparture,
            etaMinutes: arrival.etaMinutes,
            waitMinutes: Math.max(arrival.etaMinutes, 0),
            travelTimeMinutes: arrival.travelTimeToDestinationMinutes,
            arrivalTime:
              arrival.travelTimeToDestinationMinutes !== null
                ? new Date(new Date(arrival.estimatedDeparture).getTime() + arrival.travelTimeToDestinationMinutes * 60000).toISOString()
                : null,
            delaySeconds: arrival.delaySeconds,
            vehicleLabel: arrival.vehicleLabel,
            shapePoints: shapePointsForTrip(staticData, arrival.tripId),
            confidenceScore: arrival.confidenceScore,
            confidenceLevel: arrival.confidenceLevel,
            recommendation: arrival.recommendation,
            reasons: arrival.reasons,
          } satisfies CommuteOption))
          .sort((a, b) => {
            const recommendationWeight = (value: CommuteOption) =>
              value.recommendation === 'recommended' ? 0 : value.recommendation === 'consider' ? 1 : 2;
            if (recommendationWeight(a) !== recommendationWeight(b)) {
              return recommendationWeight(a) - recommendationWeight(b);
            }
            if (b.confidenceScore !== a.confidenceScore) {
              return b.confidenceScore - a.confidenceScore;
            }
            if (a.waitMinutes !== b.waitMinutes) {
              return a.waitMinutes - b.waitMinutes;
            }
            return (a.travelTimeMinutes ?? Number.MAX_SAFE_INTEGER) - (b.travelTimeMinutes ?? Number.MAX_SAFE_INTEGER);
          })
          .slice(0, 5)
      : [];

    const bestForDestination = suggestedOptions[0] ?? null;

    const routePreviews = destinationStopId
      ? Array.from(staticData.tripsById.values())
          .flatMap((trip) => {
            const stopTimesForTrip = staticData.stopTimesByTripId.get(trip.tripId) ?? [];
            const originStopTime = stopTimesForTrip.find((entry) => entry.stopId === stopId);
            const destinationStopTime = stopTimesForTrip.find(
              (entry) => entry.stopId === destinationStopId && originStopTime && entry.stopSequence > originStopTime.stopSequence,
            );

            if (!originStopTime || !destinationStopTime) {
              return [];
            }

            const route = staticData.routesById.get(trip.routeId);
            const originPublicStop = staticData.stopsById.get(stopId);
            const destinationPublicStop = staticData.stopsById.get(destinationStopId);
            if (!route || !originPublicStop || !destinationPublicStop) {
              return [];
            }

            return [{
              routeId: route.routeId,
              routeShortName: route.routeShortName,
              routeLongName: route.routeLongName,
              routeColor: normalizeColor(route.routeColor, '#0A9396'),
              routeTextColor: normalizeColor(route.routeTextColor, '#FFFFFF'),
              headsign: trip.tripHeadsign || route.routeLongName,
              originStopId: stopId,
              originStopName: originPublicStop.stopName,
              destinationStopId,
              destinationStopName: destinationPublicStop.stopName,
              shapePoints: shapePointsForTrip(staticData, trip.tripId),
            } satisfies RoutePreview];
          })
          .filter((preview) => preview.shapePoints.length > 1)
          .reduce((accumulator, preview) => {
            if (!accumulator.has(preview.routeId)) {
              accumulator.set(preview.routeId, preview);
            }
            return accumulator;
          }, new Map<string, RoutePreview>())
      : new Map<string, RoutePreview>();

    return {
      stop: stopToPublic(stop, Array.from(staticData.stopRouteIds.get(stopId) ?? [])),
      arrivals,
      bestForDestination,
      suggestedOptions,
      routePreviews: Array.from(routePreviews.values()),
    };
  }

  private buildJourneyPlan(
    staticData: StaticDataset | null,
    realtimeData: RealtimeDataset | null,
    originStopId: string,
    destinationStopId: string,
  ): JourneyPlanResponse {
    if (!staticData) {
      return {
        originStop: null,
        destinationStop: null,
        bestOption: null,
        options: [],
        routePreviews: [],
      };
    }

    const originStop = staticData.stopsById.get(originStopId);
    const destinationStop = staticData.stopsById.get(destinationStopId);
    if (!originStop || !destinationStop) {
      return {
        originStop: originStop ? stopToPublic(originStop, Array.from(staticData.stopRouteIds.get(originStopId) ?? [])) : null,
        destinationStop: destinationStop ? stopToPublic(destinationStop, Array.from(staticData.stopRouteIds.get(destinationStopId) ?? [])) : null,
        bestOption: null,
        options: [],
        routePreviews: [],
      };
    }

    const directResponse = this.buildArrivals(staticData, realtimeData, originStopId, destinationStopId);
    const allOriginArrivals = this.buildArrivals(staticData, realtimeData, originStopId).arrivals;
    const transferArrivalCache = new Map<string, TransitArrival[]>();

    const getTransferArrivals = (stopId: string) => {
      if (!transferArrivalCache.has(stopId)) {
        transferArrivalCache.set(
          stopId,
          this.buildArrivals(staticData, realtimeData, stopId, destinationStopId).arrivals.filter((arrival) => arrival.destinationReachable),
        );
      }
      return transferArrivalCache.get(stopId) ?? [];
    };

    const toJourneyLeg = (params: {
      arrival: TransitArrival;
      fromStopId: string;
      fromStopName: string;
      toStopId: string;
      toStopName: string;
      arrivalTime: string;
      rideMinutes: number;
    }): JourneyLeg => ({
      tripId: params.arrival.tripId,
      routeId: params.arrival.routeId,
      routeShortName: params.arrival.routeShortName,
      routeColor: params.arrival.routeColor,
      routeTextColor: params.arrival.routeTextColor,
      headsign: params.arrival.headsign,
      fromStopId: params.fromStopId,
      fromStopName: params.fromStopName,
      toStopId: params.toStopId,
      toStopName: params.toStopName,
      departureTime: params.arrival.estimatedDeparture,
      arrivalTime: params.arrivalTime,
      waitMinutes: Math.max(params.arrival.etaMinutes, 0),
      rideMinutes: params.rideMinutes,
      delaySeconds: params.arrival.delaySeconds,
      vehicleLabel: params.arrival.vehicleLabel,
      confidenceScore: params.arrival.confidenceScore,
      confidenceLevel: params.arrival.confidenceLevel,
      recommendation: params.arrival.recommendation,
      reasons: params.arrival.reasons,
      shapePoints: shapePointsForTrip(staticData, params.arrival.tripId),
    });

    const directOptions: JourneyOption[] = directResponse.arrivals
      .filter((arrival) => arrival.destinationReachable)
      .slice(0, 4)
      .map((arrival) => {
        const arrivalTime =
          arrival.travelTimeToDestinationMinutes !== null
            ? new Date(new Date(arrival.estimatedDeparture).getTime() + arrival.travelTimeToDestinationMinutes * 60000).toISOString()
            : arrival.estimatedDeparture;
        const leg = toJourneyLeg({
          arrival,
          fromStopId: originStopId,
          fromStopName: originStop.stopName,
          toStopId: destinationStopId,
          toStopName: destinationStop.stopName,
          arrivalTime,
          rideMinutes: arrival.travelTimeToDestinationMinutes ?? 0,
        });

        return {
          id: `direct-${arrival.tripId}-${arrival.estimatedDeparture}`,
          legCount: 1,
          departureTime: leg.departureTime,
          arrivalTime: leg.arrivalTime,
          totalWaitMinutes: leg.waitMinutes,
          totalRideMinutes: leg.rideMinutes,
          totalDurationMinutes: leg.waitMinutes + leg.rideMinutes,
          transferStopId: null,
          transferStopName: null,
          confidenceScore: arrival.confidenceScore,
          confidenceLevel: arrival.confidenceLevel,
          recommendation: arrival.recommendation,
          reasons: arrival.reasons,
          legs: [leg],
        } satisfies JourneyOption;
      });

    const transferOptions: JourneyOption[] = allOriginArrivals
      .slice(0, 8)
      .flatMap((firstArrival) => {
        const tripStopTimes = staticData.stopTimesByTripId.get(firstArrival.tripId) ?? [];
        const originStopTime = tripStopTimes.find((entry) => entry.stopId === originStopId);
        if (!originStopTime) {
          return [];
        }

        const firstTripUpdate = realtimeData?.tripUpdates.get(firstArrival.tripId) ?? null;
        const downstreamStops = tripStopTimes
          .filter((entry) => entry.stopSequence > originStopTime.stopSequence && entry.stopId !== destinationStopId)
          .slice(0, 8);

        return downstreamStops.flatMap((transferStopTime) => {
          const transferStop = staticData.stopsById.get(transferStopTime.stopId);
          if (!transferStop) {
            return [];
          }

          const transferArrivalUpdate = firstTripUpdate
            ? findStopUpdate(firstTripUpdate.stopTimeUpdates, transferStopTime.stopId, transferStopTime.stopSequence)
            : null;
          const firstLegArrivalTime = transferArrivalUpdate?.arrivalTimeMs
            ? new Date(transferArrivalUpdate.arrivalTimeMs).toISOString()
            : formatSecondsToLocalIso(new Date(), transferStopTime.arrivalSeconds);
          const firstLegRideMinutes = minutesBetween(firstArrival.estimatedDeparture, firstLegArrivalTime);
          const secondCandidates = getTransferArrivals(transferStopTime.stopId)
            .filter((secondArrival) => {
              if (secondArrival.tripId === firstArrival.tripId) {
                return false;
              }
              return new Date(secondArrival.estimatedDeparture).getTime() >= new Date(firstLegArrivalTime).getTime() + 2 * 60 * 1000;
            })
            .slice(0, 2);

          return secondCandidates.map((secondArrival) => {
            const secondLegArrivalTime =
              secondArrival.travelTimeToDestinationMinutes !== null
                ? new Date(new Date(secondArrival.estimatedDeparture).getTime() + secondArrival.travelTimeToDestinationMinutes * 60000).toISOString()
                : secondArrival.estimatedDeparture;

            const firstLeg = toJourneyLeg({
              arrival: firstArrival,
              fromStopId: originStopId,
              fromStopName: originStop.stopName,
              toStopId: transferStop.stopId,
              toStopName: transferStop.stopName,
              arrivalTime: firstLegArrivalTime,
              rideMinutes: firstLegRideMinutes,
            });
            const secondLeg = toJourneyLeg({
              arrival: secondArrival,
              fromStopId: transferStop.stopId,
              fromStopName: transferStop.stopName,
              toStopId: destinationStopId,
              toStopName: destinationStop.stopName,
              arrivalTime: secondLegArrivalTime,
              rideMinutes: secondArrival.travelTimeToDestinationMinutes ?? 0,
            });

            const totalWaitMinutes = firstLeg.waitMinutes + Math.max(0, minutesBetween(firstLeg.arrivalTime, secondLeg.departureTime));
            const totalRideMinutes = firstLeg.rideMinutes + secondLeg.rideMinutes;
            const totalDurationMinutes = minutesBetween(new Date().toISOString(), secondLeg.arrivalTime);
            const confidenceScore = Math.max(0, Math.round((firstLeg.confidenceScore + secondLeg.confidenceScore) / 2 - 6));
            const confidenceLevel: JourneyOption['confidenceLevel'] = confidenceScore >= 90 ? 'HIGH' : confidenceScore >= 70 ? 'MEDIUM' : 'LOW';
            const recommendation: JourneyOption['recommendation'] =
              confidenceScore >= 75 ? 'recommended' : confidenceScore >= 60 ? 'consider' : 'wait';

            return {
              id: `transfer-${firstArrival.tripId}-${secondArrival.tripId}-${transferStop.stopId}`,
              legCount: 2,
              departureTime: firstLeg.departureTime,
              arrivalTime: secondLeg.arrivalTime,
              totalWaitMinutes,
              totalRideMinutes,
              totalDurationMinutes,
              transferStopId: transferStop.stopId,
              transferStopName: transferStop.stopName,
              confidenceScore,
              confidenceLevel,
              recommendation,
              reasons: [
                firstLeg.reasons[0] ?? 'first leg is live',
                `transfer at ${transferStop.stopName}`,
                secondLeg.reasons[0] ?? 'second leg is live',
              ],
              legs: [firstLeg, secondLeg],
            } satisfies JourneyOption;
          });
        });
      });

    const options = [...directOptions, ...transferOptions]
      .sort((a, b) => {
        if (recommendationWeight(a) !== recommendationWeight(b)) {
          return recommendationWeight(a) - recommendationWeight(b);
        }
        if (b.confidenceScore !== a.confidenceScore) {
          return b.confidenceScore - a.confidenceScore;
        }
        return a.totalDurationMinutes - b.totalDurationMinutes;
      })
      .filter((option, index, allOptions) => index === allOptions.findIndex((candidate) => candidate.id === option.id))
      .slice(0, 6);

    const routePreviews = options
      .flatMap((option) =>
        option.legs.map((leg) => {
          const route = staticData.routesById.get(leg.routeId);
          if (!route) {
            return null;
          }
          return {
            routeId: route.routeId,
            routeShortName: route.routeShortName,
            routeLongName: route.routeLongName,
            routeColor: normalizeColor(route.routeColor, '#0A9396'),
            routeTextColor: normalizeColor(route.routeTextColor, '#FFFFFF'),
            headsign: leg.headsign,
            originStopId: leg.fromStopId,
            originStopName: leg.fromStopName,
            destinationStopId: leg.toStopId,
            destinationStopName: leg.toStopName,
            shapePoints: leg.shapePoints,
          } satisfies RoutePreview;
        }),
      )
      .filter((preview): preview is RoutePreview => Boolean(preview))
      .reduce((accumulator, preview) => {
        if (!accumulator.has(preview.routeId)) {
          accumulator.set(preview.routeId, preview);
        }
        return accumulator;
      }, new Map<string, RoutePreview>());

    return {
      originStop: stopToPublic(originStop, Array.from(staticData.stopRouteIds.get(originStopId) ?? [])),
      destinationStop: stopToPublic(destinationStop, Array.from(staticData.stopRouteIds.get(destinationStopId) ?? [])),
      bestOption: options[0] ?? null,
      options,
      routePreviews: Array.from(routePreviews.values()),
    };
  }

  async getNearestStops(lat: number, lng: number, limit = 3, radiusMeters = 1500): Promise<AddressResolvedStop[]> {
    const { staticData } = await this.getDatasets();
    if (!staticData) {
      return [];
    }

    return Array.from(staticData.stopsById.values())
      .map((stop) => ({
        stop,
        distanceMeters: haversineMeters(lat, lng, stop.stopLat, stop.stopLng),
        routeCount: (staticData.stopRouteIds.get(stop.stopId) ?? new Set<string>()).size,
      }))
      .filter((entry) => entry.distanceMeters <= radiusMeters)
      .sort((a, b) => {
        if (Math.abs(a.distanceMeters - b.distanceMeters) > 75) {
          return a.distanceMeters - b.distanceMeters;
        }
        if (b.routeCount !== a.routeCount) {
          return b.routeCount - a.routeCount;
        }
        return a.stop.stopName.localeCompare(b.stop.stopName);
      })
      .slice(0, limit)
      .map((entry) => ({
        ...stopToPublic(entry.stop, Array.from(staticData.stopRouteIds.get(entry.stop.stopId) ?? [])),
        distanceMeters: Math.round(entry.distanceMeters),
        walkingMinutes: Math.max(1, Math.round(entry.distanceMeters / 80)),
        routeCount: entry.routeCount,
      }));
  }

  async getRoutes(): Promise<TransitApiResponse<RouteResponse>> {
    const { staticData, realtimeData, meta } = await this.getDatasets();
    const vehicles = this.buildVehicles(staticData, realtimeData);
    return {
      data: {
        routes: this.buildRoutes(staticData, vehicles),
      },
      meta,
    };
  }

  async getVehicles(): Promise<TransitApiResponse<VehicleResponse>> {
    const { staticData, realtimeData, meta } = await this.getDatasets();
    return {
      data: {
        vehicles: this.buildVehicles(staticData, realtimeData),
      },
      meta,
    };
  }

  async searchStops(query = ''): Promise<TransitApiResponse<StopSearchResponse>> {
    const { staticData, meta } = await this.getDatasets();
    if (!staticData) {
      return {
        data: { stops: [] },
        meta,
      };
    }

    const normalizedQuery = query.trim().toLowerCase();
    const stops = Array.from(staticData.stopsById.values())
      .filter((stop) => {
        if (!normalizedQuery) {
          return true;
        }
        return stop.stopName.toLowerCase().includes(normalizedQuery) || stop.stopCode.toLowerCase().includes(normalizedQuery);
      })
      .slice(0, normalizedQuery ? 24 : 80)
      .map((stop) => stopToPublic(stop, Array.from(staticData.stopRouteIds.get(stop.stopId) ?? [])))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      data: { stops },
      meta,
    };
  }

  async getStopArrivals(stopId: string, destinationStopId?: string): Promise<TransitApiResponse<StopArrivalsResponse>> {
    const { staticData, realtimeData, meta } = await this.getDatasets();
    return {
      data: this.buildArrivals(staticData, realtimeData, stopId, destinationStopId),
      meta,
    };
  }

  async getJourney(originStopId: string, destinationStopId: string): Promise<TransitApiResponse<{ journey: JourneyPlanResponse }>> {
    const { staticData, realtimeData, meta } = await this.getDatasets();
    return {
      data: {
        journey: this.buildJourneyPlan(staticData, realtimeData, originStopId, destinationStopId),
      },
      meta,
    };
  }

  async getAlerts(): Promise<TransitApiResponse<{ alerts: TransitAlert[] }>> {
    const { realtimeData, meta } = await this.getDatasets();
    return {
      data: {
        alerts: realtimeData?.alerts ?? [],
      },
      meta,
    };
  }

  async getNearby(lat: number, lng: number, radiusMeters = 900): Promise<TransitApiResponse<NearbyResponse>> {
    const { staticData, realtimeData, meta } = await this.getDatasets();

    if (!staticData) {
      return {
        data: {
          nearby: {
            stops: [],
            vehicles: [],
            bestDeparture: null,
          },
        },
        meta,
      };
    }

    const nearbyStops: NearbyStop[] = Array.from(staticData.stopsById.values())
      .map((stop) => ({
        stop,
        distanceMeters: haversineMeters(lat, lng, stop.stopLat, stop.stopLng),
      }))
      .filter((entry) => entry.distanceMeters <= radiusMeters)
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, 8)
      .map((entry) => {
        const arrivals = this.buildArrivals(staticData, realtimeData, entry.stop.stopId).arrivals;
        return {
          ...stopToPublic(entry.stop, Array.from(staticData.stopRouteIds.get(entry.stop.stopId) ?? [])),
          distanceMeters: Math.round(entry.distanceMeters),
          nextArrival: arrivals[0] ?? null,
        } satisfies NearbyStop;
      });

    const vehicles = this.buildVehicles(staticData, realtimeData);
    const nearbyVehicles: NearbyVehicle[] = vehicles
      .map((vehicle) => ({
        ...vehicle,
        distanceMeters: Math.round(haversineMeters(lat, lng, vehicle.lat, vehicle.lng)),
      }))
      .filter((vehicle) => vehicle.distanceMeters <= radiusMeters * 1.8)
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, 12);

    const bestDeparture = nearbyStops
      .map((stop) => stop.nextArrival)
      .filter((arrival): arrival is NonNullable<typeof arrival> => Boolean(arrival))
      .sort((a, b) => a.etaMinutes - b.etaMinutes)[0] ?? null;

    const nearby: NearbyTransit = {
      stops: nearbyStops,
      vehicles: nearbyVehicles,
      bestDeparture,
    };

    return {
      data: { nearby },
      meta,
    };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __guelphTransitService__: TransitService | undefined;
}

export function getTransitService() {
  if (!globalThis.__guelphTransitService__) {
    globalThis.__guelphTransitService__ = new TransitService();
  }

  return globalThis.__guelphTransitService__;
}

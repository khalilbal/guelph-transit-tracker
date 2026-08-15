import { transit_realtime } from 'gtfs-realtime-bindings';

import { formatIso } from '@/lib/transit/time';
import {
  RealtimeAlert,
  RealtimeDataset,
  RealtimeStopTimeUpdate,
  RealtimeTripUpdate,
  RealtimeVehiclePosition,
} from '@/lib/transit/types';

function decodeFeed(bytes: Uint8Array) {
  return transit_realtime.FeedMessage.decode(bytes);
}

function translatedText(input: transit_realtime.ITranslatedString | null | undefined): string {
  return input?.translation?.map((entry) => entry.text).filter(Boolean).join(' ') || '';
}

function toMs(value: number | Long | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = typeof value === 'object' && 'toNumber' in value ? value.toNumber() : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return numeric * 1000;
}

async function fetchFeed(url: string) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Realtime feed request failed with ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return decodeFeed(new Uint8Array(arrayBuffer));
}

export async function loadRealtimeFeeds(urls: {
  vehiclesUrl: string;
  tripUpdatesUrl: string;
  alertsUrl: string;
}): Promise<RealtimeDataset> {
  const [vehicleFeed, tripFeed, alertFeed] = await Promise.all([
    fetchFeed(urls.vehiclesUrl),
    fetchFeed(urls.tripUpdatesUrl),
    fetchFeed(urls.alertsUrl),
  ]);

  const feedTimestampMs = [vehicleFeed, tripFeed, alertFeed]
    .map((feed) => toMs(feed.header.timestamp))
    .filter((value): value is number => value !== null)
    .sort((a, b) => b - a)[0] ?? null;

  const vehicles: RealtimeVehiclePosition[] = vehicleFeed.entity
    .map((entity) => entity.vehicle)
    .filter(Boolean)
    .map((vehicle) => ({
      id: vehicle!.vehicle?.id || vehicle!.vehicle?.label || vehicle!.trip?.tripId || crypto.randomUUID(),
      label: vehicle!.vehicle?.label || vehicle!.vehicle?.id || 'Bus',
      tripId: vehicle!.trip?.tripId || null,
      routeId: vehicle!.trip?.routeId || null,
      lat: Number(vehicle!.position?.latitude || 0),
      lng: Number(vehicle!.position?.longitude || 0),
      bearing: vehicle!.position?.bearing ?? null,
      speedKph: vehicle!.position?.speed ? Number(vehicle!.position.speed) * 3.6 : null,
      timestampMs: toMs(vehicle!.timestamp),
      status: String(vehicle!.currentStatus ?? 'IN_TRANSIT_TO'),
      currentStopSequence: vehicle!.currentStopSequence ?? null,
    }))
    .filter((vehicle) => Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lng));

  const tripUpdates = new Map<string, RealtimeTripUpdate>();
  tripFeed.entity
    .map((entity) => entity.tripUpdate)
    .filter(Boolean)
    .forEach((tripUpdate) => {
      const tripId = tripUpdate!.trip?.tripId;
      if (!tripId) {
        return;
      }

      const stopTimeUpdates: RealtimeStopTimeUpdate[] = (tripUpdate!.stopTimeUpdate || []).map((update) => ({
        stopId: update.stopId || null,
        stopSequence: update.stopSequence ?? null,
        arrivalTimeMs: toMs(update.arrival?.time),
        departureTimeMs: toMs(update.departure?.time),
        delaySeconds:
          update.arrival?.delay ?? update.departure?.delay ?? tripUpdate!.delay ?? null,
      }));

      tripUpdates.set(tripId, {
        tripId,
        vehicleId: tripUpdate!.vehicle?.id || null,
        vehicleLabel: tripUpdate!.vehicle?.label || tripUpdate!.vehicle?.id || null,
        timestampMs: toMs(tripUpdate!.timestamp),
        delaySeconds: tripUpdate!.delay ?? null,
        stopTimeUpdates,
      });
    });

  const alerts: RealtimeAlert[] = alertFeed.entity
    .map((entity) => entity.alert)
    .filter(Boolean)
    .map((alert, index) => ({
      id: alertFeed.entity[index]?.id || `alert-${index}`,
      header: translatedText(alert!.headerText) || 'Service alert',
      description: translatedText(alert!.descriptionText),
      severity: String(alert!.severityLevel ?? 'UNKNOWN_SEVERITY'),
      effect: String(alert!.effect ?? 'UNKNOWN_EFFECT'),
      routeIds: (alert!.informedEntity || []).map((entity) => entity.routeId).filter(Boolean) as string[],
      stopIds: (alert!.informedEntity || []).map((entity) => entity.stopId).filter(Boolean) as string[],
      activePeriods: (alert!.activePeriod || []).map((period) => ({
        start: formatIso(toMs(period.start)),
        end: formatIso(toMs(period.end)),
      })),
      url: translatedText(alert!.url) || null,
    }));

  return {
    vehicles,
    tripUpdates,
    alerts,
    feedTimestampMs,
  };
}

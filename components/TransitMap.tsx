'use client';

import 'leaflet/dist/leaflet.css';

import clsx from 'clsx';
import L from 'leaflet';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Circle,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from 'react-leaflet';

import { TransitStop, TransitVehicle } from '@/lib/transit/types';
import { compactRouteLabel } from '@/lib/utils/routes';

type UserLocation = {
  lat: number;
  lng: number;
};

type AddressPin = {
  id: string;
  label: string;
  lat: number;
  lng: number;
  tone: 'search' | 'origin' | 'destination';
};

export type BasemapMode = 'street' | 'satellite';

type TransitMapProps = {
  vehicles: TransitVehicle[];
  highlightedStops: TransitStop[];
  addressPins: AddressPin[];
  basemapMode: BasemapMode;
  contextualRouteIds: string[];
  highlightedRoutePaths: Array<Array<{ lat: number; lng: number }>>;
  highlightedRouteColor: string | null;
  selectedStop: TransitStop | null;
  selectedVehicleId: string | null;
  followedVehicleId: string | null;
  userLocation: UserLocation | null;
  defaultCenter: [number, number];
  defaultZoom: number;
  refreshIntervalMs: number;
  onSelectStop: (stop: TransitStop) => void;
  onSelectVehicle: (vehicleId: string) => void;
};

type AnimatedVehicle = TransitVehicle & {
  displayLat: number;
  displayLng: number;
  displayBearing: number | null;
};

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function vehicleIcon(vehicle: TransitVehicle, selected: boolean, emphasized: boolean) {
  const color = vehicle.routeColor;
  const textColor = vehicle.routeTextColor;
  const rotation = vehicle.bearing ?? 0;
  const routeLabel = compactRouteLabel(vehicle.routeShortName, vehicle.headsign);
  const vehicleLabel = vehicle.label?.trim() || 'Bus';
  const emphasisClass = emphasized ? 'vehicle-marker-emphasized' : 'vehicle-marker-muted';

  return L.divIcon({
    className: 'vehicle-marker-shell',
    html: `<div style="transform: rotate(${rotation}deg);" class="vehicle-marker ${emphasisClass} ${selected ? 'vehicle-marker-selected' : ''}">
      <div class="vehicle-marker-pill" style="background:${color};color:${textColor};border-color:${selected ? '#ffd166' : 'rgba(255,255,255,0.82)'};">
        <div class="vehicle-marker-label">${escapeHtml(routeLabel)}</div>
        <div class="vehicle-marker-subtitle">${escapeHtml(vehicleLabel)}</div>
      </div>
    </div>`,
    iconAnchor: [37, 18],
    popupAnchor: [0, -22],
  });
}

const stopIcon = L.divIcon({
  className: 'stop-marker-shell',
  html: '<div class="stop-marker"></div>',
  iconAnchor: [9, 9],
  popupAnchor: [0, -10],
});

function addressIcon(pin: AddressPin) {
  const palette =
    pin.tone === 'origin'
      ? { fill: '#2563eb', border: '#ffffff', text: 'Origin' }
      : pin.tone === 'destination'
        ? { fill: '#7c3aed', border: '#ffffff', text: 'Dest' }
        : { fill: '#0f766e', border: '#ffffff', text: 'Addr' };

  return L.divIcon({
    className: 'address-marker-shell',
    html: `<div class="address-marker" style="background:${palette.fill};border-color:${palette.border};">
      <span class="address-marker-label">${escapeHtml(palette.text)}</span>
    </div>`,
    iconAnchor: [16, 16],
    popupAnchor: [0, -14],
  });
}

function MapEffects({
  followedVehicle,
  selectedStop,
  userLocation,
  addressPins,
}: {
  followedVehicle: AnimatedVehicle | null;
  selectedStop: TransitStop | null;
  userLocation: UserLocation | null;
  addressPins: AddressPin[];
}) {
  const map = useMap();

  useEffect(() => {
    if (followedVehicle) {
      map.flyTo([followedVehicle.displayLat, followedVehicle.displayLng], Math.max(map.getZoom(), 15), {
        duration: 0.8,
      });
    }
  }, [followedVehicle, map]);

  useEffect(() => {
    if (selectedStop && !followedVehicle) {
      map.flyTo([selectedStop.lat, selectedStop.lng], Math.max(map.getZoom(), 16), {
        duration: 0.7,
      });
    }
  }, [selectedStop, followedVehicle, map]);

  useEffect(() => {
    if (addressPins.length === 1 && !followedVehicle && !selectedStop) {
      map.flyTo([addressPins[0].lat, addressPins[0].lng], Math.max(map.getZoom(), 16), {
        duration: 0.7,
      });
    }
  }, [addressPins, followedVehicle, selectedStop, map]);

  useEffect(() => {
    if (userLocation && !followedVehicle && !selectedStop) {
      map.flyTo([userLocation.lat, userLocation.lng], Math.max(map.getZoom(), 14), {
        duration: 0.7,
      });
    }
  }, [userLocation, followedVehicle, selectedStop, map]);

  return null;
}

export function TransitMap({
  vehicles,
  highlightedStops,
  addressPins,
  basemapMode,
  contextualRouteIds,
  highlightedRoutePaths,
  highlightedRouteColor,
  selectedStop,
  selectedVehicleId,
  followedVehicleId,
  userLocation,
  defaultCenter,
  defaultZoom,
  refreshIntervalMs,
  onSelectStop,
  onSelectVehicle,
}: TransitMapProps) {
  const [animatedVehicles, setAnimatedVehicles] = useState<AnimatedVehicle[]>(() =>
    vehicles.map((vehicle) => ({
      ...vehicle,
      displayLat: vehicle.lat,
      displayLng: vehicle.lng,
      displayBearing: vehicle.bearing,
    })),
  );
  const previousFrameRef = useRef<Map<string, AnimatedVehicle>>(new Map());

  useEffect(() => {
    const from = new Map(previousFrameRef.current);
    const target = vehicles.map((vehicle) => ({
      ...vehicle,
      displayLat: vehicle.lat,
      displayLng: vehicle.lng,
      displayBearing: vehicle.bearing,
    }));

    const duration = Math.max(900, refreshIntervalMs - 300);
    const start = performance.now();
    let frameId = 0;

    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - (1 - progress) * (1 - progress);

      const nextFrame = target.map((vehicle) => {
        const previous = from.get(vehicle.id);
        if (!previous) {
          return vehicle;
        }

        const latDelta = Math.abs(vehicle.lat - previous.displayLat);
        const lngDelta = Math.abs(vehicle.lng - previous.displayLng);
        const shouldSnap = latDelta + lngDelta > 0.03 || previous.isStale !== vehicle.isStale;
        if (shouldSnap) {
          return vehicle;
        }

        const bearingStart = previous.displayBearing ?? vehicle.bearing ?? 0;
        const bearingEnd = vehicle.bearing ?? bearingStart;

        return {
          ...vehicle,
          displayLat: previous.displayLat + (vehicle.lat - previous.displayLat) * eased,
          displayLng: previous.displayLng + (vehicle.lng - previous.displayLng) * eased,
          displayBearing: bearingStart + (bearingEnd - bearingStart) * eased,
        } satisfies AnimatedVehicle;
      });

      setAnimatedVehicles(nextFrame);
      previousFrameRef.current = new Map(nextFrame.map((vehicle) => [vehicle.id, vehicle]));

      if (progress < 1) {
        frameId = window.requestAnimationFrame(tick);
      }
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [vehicles, refreshIntervalMs]);

  const contextualRouteSet = useMemo(() => new Set(contextualRouteIds), [contextualRouteIds]);
  const followedVehicle = useMemo(
    () => animatedVehicles.find((vehicle) => vehicle.id === followedVehicleId) ?? null,
    [animatedVehicles, followedVehicleId],
  );
  const basemap = useMemo(
    () =>
      basemapMode === 'satellite'
        ? {
            attribution:
              'Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          }
        : {
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
          },
    [basemapMode],
  );

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[2rem] border border-white/45 bg-white/30 shadow-glow backdrop-blur dark:border-white/10 dark:bg-slate-900/60">
      <MapContainer
        center={defaultCenter}
        zoom={defaultZoom}
        scrollWheelZoom
        className="h-full w-full"
        zoomControl={false}
      >
        <TileLayer attribution={basemap.attribution} url={basemap.url} />

        <MapEffects
          followedVehicle={followedVehicle}
          selectedStop={selectedStop}
          userLocation={userLocation}
          addressPins={addressPins}
        />

        {userLocation ? (
          <>
            <Circle center={[userLocation.lat, userLocation.lng]} radius={110} pathOptions={{ color: '#3b82f6', fillOpacity: 0.08 }} />
            <Circle center={[userLocation.lat, userLocation.lng]} radius={16} pathOptions={{ color: '#2563eb', fillColor: '#60a5fa', fillOpacity: 0.95 }} />
          </>
        ) : null}

        {highlightedStops.map((stop) => (
          <Marker
            key={stop.id}
            position={[stop.lat, stop.lng]}
            icon={stopIcon}
            eventHandlers={{ click: () => onSelectStop(stop) }}
          >
            <Popup>
              <div className="space-y-1">
                <div className="font-semibold">{stop.name}</div>
                <div className="text-xs text-slate-500">Stop {stop.code}</div>
              </div>
            </Popup>
          </Marker>
        ))}

        {addressPins.map((pin) => (
          <Marker key={pin.id} position={[pin.lat, pin.lng]} icon={addressIcon(pin)}>
            <Popup>
              <div className="space-y-1">
                <div className="font-semibold">{pin.label}</div>
                <div className="text-xs text-slate-500">
                  {pin.tone === 'origin'
                    ? 'Origin address'
                    : pin.tone === 'destination'
                      ? 'Destination address'
                      : 'Matched address'}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}

        {highlightedRoutePaths
          .filter((path) => path.length > 1)
          .map((path, index) => (
            <Polyline
              key={`highlighted-route-${index}`}
              positions={path.map((point) => [point.lat, point.lng] as [number, number])}
              pathOptions={{
                color: highlightedRouteColor ?? '#ff6b35',
                weight: 6,
                opacity: index === 0 ? 0.82 : 0.55,
              }}
            />
          ))}

        {animatedVehicles.map((vehicle) => (
          <Marker
            key={vehicle.id}
            position={[vehicle.displayLat, vehicle.displayLng]}
            icon={vehicleIcon(
              vehicle,
              vehicle.id === selectedVehicleId || vehicle.id === followedVehicleId,
              contextualRouteSet.size === 0 || (vehicle.routeId ? contextualRouteSet.has(vehicle.routeId) : false),
            )}
            eventHandlers={{ click: () => onSelectVehicle(vehicle.id) }}
          >
            <Popup>
              <div className="min-w-[180px] space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="rounded-full px-2 py-1 text-xs font-bold"
                    style={{ backgroundColor: vehicle.routeColor, color: vehicle.routeTextColor }}
                  >
                    Route {compactRouteLabel(vehicle.routeShortName, vehicle.headsign)}
                  </span>
                  <span className={clsx('text-xs font-medium', vehicle.isStale ? 'text-amber-600' : 'text-emerald-600')}>
                    {vehicle.isStale ? 'Stale' : 'Live'}
                  </span>
                </div>
                <div className="text-sm font-semibold text-slate-800">{vehicle.headsign}</div>
                <div className="space-y-1 text-xs text-slate-600">
                  <div>Vehicle: {vehicle.label}</div>
                  <div>Next stop: {vehicle.nextStopName ?? 'Not available'}</div>
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}

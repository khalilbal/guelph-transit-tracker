'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Compass,
  Heart,
  LocateFixed,
  MapPinned,
  Moon,
  Navigation,
  Radar,
  RefreshCw,
  Route,
  Search,
  Star,
  Sun,
} from 'lucide-react';
import clsx from 'clsx';
import type { BasemapMode } from '@/components/TransitMap';

import {
  AddressLookupResponse,
  AddressLookupResult,
  AlertResponse,
  ArrivalConfidenceLevel,
  ArrivalRecommendation,
  ContextualRouteHighlight,
  NearbyResponse,
  RouteResponse,
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
import { compactRouteLabel } from '@/lib/utils/routes';

const TransitMap = dynamic(() => import('@/components/TransitMap').then((mod) => mod.TransitMap), {
  ssr: false,
});

type ThemeMode = 'light' | 'dark';
type TabKey = 'search' | 'nearby' | 'alerts' | 'copilot';

type GeoState = {
  lat: number;
  lng: number;
} | null;

type CopilotLocation = {
  lat: number;
  lng: number;
  label: string;
  source: 'device' | 'address';
} | null;

type AddressPin = {
  id: string;
  label: string;
  lat: number;
  lng: number;
  tone: 'search' | 'origin' | 'destination';
} | null;

const DEFAULT_CENTER: [number, number] = [
  Number(process.env.NEXT_PUBLIC_DEFAULT_LAT ?? '43.5448'),
  Number(process.env.NEXT_PUBLIC_DEFAULT_LNG ?? '-80.2482'),
];
const DEFAULT_ZOOM = Number(process.env.NEXT_PUBLIC_DEFAULT_ZOOM ?? '13');
const LIVE_POLL_MS = Number(process.env.NEXT_PUBLIC_LIVE_POLL_INTERVAL_MS ?? '5000');
const ROUTE_POLL_MS = Math.max(LIVE_POLL_MS, 15000);
const ALERT_POLL_MS = Math.max(LIVE_POLL_MS, 15000);

function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(initialValue);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored !== null) {
        setValue(JSON.parse(stored) as T);
      }
    } catch {
      // Ignore invalid storage.
    }
  }, [key]);

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore storage write failures.
    }
  }, [key, value]);

  return [value, setValue] as const;
}

function usePollingApi<T>(url: string | null, intervalMs: number, enabled = true) {
  const [data, setData] = useState<TransitApiResponse<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    if (!url || !enabled) {
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setNextRefreshAt(Date.now() + intervalMs);

    try {
      setLoading(true);
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      const payload = (await response.json()) as TransitApiResponse<T>;
      setData(payload);
      setError(null);
      setLastUpdatedAt(Date.now());
    } catch (fetchError) {
      if ((fetchError as Error).name !== 'AbortError') {
        setError((fetchError as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [enabled, intervalMs, url]);

  useEffect(() => {
    if (!url || !enabled) {
      return;
    }

    void fetchData();
    const timer = window.setInterval(() => {
      void fetchData();
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [enabled, fetchData, intervalMs, url]);

  useEffect(() => {
    if (!url || !enabled || !nextRefreshAt) {
      setSecondsUntilRefresh(null);
      return;
    }

    const updateCountdown = () => {
      const remainingMs = Math.max(0, nextRefreshAt - Date.now());
      setSecondsUntilRefresh(Math.ceil(remainingMs / 1000));
    };

    updateCountdown();
    const timer = window.setInterval(updateCountdown, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, [enabled, nextRefreshAt, url]);

  return { data, error, loading, refresh: fetchData, lastUpdatedAt, nextRefreshAt, secondsUntilRefresh };
}

function formatTime(iso: string | null) {
  if (!iso) {
    return 'Unknown';
  }
  return new Intl.DateTimeFormat('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

function formatRelativeMinutes(minutes: number) {
  if (minutes <= 0) {
    return 'Now';
  }
  if (minutes === 1) {
    return '1 min';
  }
  return `${minutes} mins`;
}

function formatWalkTime(minutes: number) {
  if (minutes <= 1) {
    return '1 min walk';
  }
  return `${minutes} min walk`;
}

function formatRefreshCountdown(seconds: number | null, loading: boolean) {
  if (loading) {
    return 'Refreshing now';
  }
  if (seconds === null) {
    return 'Waiting for feed';
  }
  return `Next live refresh in ${seconds}s`;
}

function mlBadgeTone(meta: TransitMeta | null) {
  if (meta?.ml.artifactLoaded) {
    return 'border-emerald-400/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (meta?.ml.historyLoggingEnabled) {
    return 'border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  }
  return 'border-slate-300/70 bg-white/85 text-slate-600 dark:border-white/10 dark:bg-slate-950/75 dark:text-slate-300';
}

function mlBadgeLabel(meta: TransitMeta | null) {
  if (meta?.ml.artifactLoaded) {
    return 'ML active';
  }
  if (meta?.ml.historyLoggingEnabled) {
    return 'ML logging';
  }
  return 'ML ready';
}

function usesMlAssist(reasons: string[]) {
  return reasons.some((reason) => reason.toLowerCase().includes('historical model'));
}

function delayLabel(arrival: TransitArrival) {
  if (arrival.delaySeconds >= 180) {
    return `${Math.round(arrival.delaySeconds / 60)} min late`;
  }
  if (arrival.delaySeconds <= -120) {
    return `${Math.abs(Math.round(arrival.delaySeconds / 60))} min early`;
  }
  return 'On time';
}

function confidenceTone(level: ArrivalConfidenceLevel) {
  if (level === 'HIGH') {
    return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  }
  if (level === 'MEDIUM') {
    return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  }
  return 'bg-rose-500/15 text-rose-700 dark:text-rose-300';
}

function recommendationTone(recommendation: ArrivalRecommendation) {
  if (recommendation === 'recommended') {
    return 'bg-accent text-white';
  }
  if (recommendation === 'consider') {
    return 'bg-slate-900/10 text-slate-700 dark:bg-white/10 dark:text-slate-200';
  }
  return 'bg-rose-500/15 text-rose-700 dark:text-rose-300';
}

function recommendationLabel(recommendation: ArrivalRecommendation) {
  if (recommendation === 'recommended') {
    return 'Best pick';
  }
  if (recommendation === 'consider') {
    return 'Consider';
  }
  return 'Wait';
}

function reliabilityLabel(route: TransitRoute) {
  switch (route.reliability.status) {
    case 'strong':
      return 'Strong';
    case 'watch':
      return 'Watch';
    case 'disrupted':
      return 'Delay risk';
    default:
      return 'Schedule only';
  }
}

function reliabilityTone(route: TransitRoute) {
  switch (route.reliability.status) {
    case 'strong':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    case 'watch':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
    case 'disrupted':
      return 'bg-rose-500/15 text-rose-700 dark:text-rose-300';
    default:
      return 'bg-slate-500/15 text-slate-700 dark:text-slate-300';
  }
}

function collectMeta(...values: Array<TransitMeta | null | undefined>) {
  return values.find(Boolean) ?? null;
}

function SectionCard({
  title,
  subtitle,
  icon,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('rounded-[1.75rem] border border-white/45 bg-white/80 p-4 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-950/75', className)}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">{title}</div>
          {subtitle ? <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">{subtitle}</div> : null}
        </div>
        <div className="rounded-2xl bg-slate-900/5 p-2 text-slate-700 dark:bg-white/10 dark:text-white">{icon}</div>
      </div>
      {children}
    </section>
  );
}

function StopPicker({
  label,
  selectedStop,
  onSelect,
}: {
  label: string;
  selectedStop: TransitStop | null;
  onSelect: (stop: TransitStop) => void;
}) {
  const [query, setQuery] = useState(selectedStop?.name ?? '');
  const [open, setOpen] = useState(false);
  const search = usePollingApi<StopSearchResponse>(
    `/api/stops?q=${encodeURIComponent(open ? query : selectedStop?.name ?? query)}`,
    60000,
    open,
  );

  useEffect(() => {
    if (!open) {
      setQuery(selectedStop?.name ?? '');
    }
  }, [open, selectedStop]);

  return (
    <div className="relative">
      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">{label}</label>
      <div className="flex items-center rounded-2xl border border-slate-200/80 bg-white/90 px-3 py-2 shadow-sm dark:border-white/10 dark:bg-slate-900/80">
        <Search className="mr-2 h-4 w-4 text-slate-400" />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search by stop name or code"
          className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
        />
      </div>
      {open ? (
        <div className="absolute inset-x-0 z-[1000] mt-2 max-h-64 overflow-y-auto rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-2xl dark:border-white/10 dark:bg-slate-950/95">
          {search.loading ? <div className="p-3 text-sm text-slate-500">Searching stops...</div> : null}
          {search.data?.data.stops.map((stop) => (
            <button
              key={stop.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onSelect(stop);
                setOpen(false);
                setQuery(stop.name);
              }}
              className="flex w-full items-start justify-between rounded-2xl px-3 py-3 text-left transition hover:bg-slate-100 dark:hover:bg-white/5"
            >
              <span>
                <span className="block text-sm font-semibold">{stop.name}</span>
                <span className="text-xs text-slate-500">Stop {stop.code}</span>
              </span>
              <span className="text-[11px] text-slate-400">{stop.routeIds.slice(0, 3).join(' • ')}</span>
            </button>
          ))}
          {!search.loading && !search.data?.data.stops.length ? <div className="p-3 text-sm text-slate-500">No stops found.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function AddressLookupPicker({
  label,
  ctaLabel,
  onSelectStop,
  onSelectAddress,
}: {
  label: string;
  ctaLabel: string;
  onSelectStop: (stop: TransitStop) => void;
  onSelectAddress?: (result: AddressLookupResult) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddressLookupResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const lookupAddress = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 3) {
      setError(trimmed.length > 0 ? 'Keep typing your Guelph address.' : null);
      setResults([]);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const response = await fetch(`/api/geocode?q=${encodeURIComponent(trimmed)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });

      const payload = (await response.json()) as AddressLookupResponse | { error?: string };
      if (!response.ok) {
        throw new Error('error' in payload && payload.error ? payload.error : `Request failed with ${response.status}`);
      }

      setResults((payload as AddressLookupResponse).results);
      if (!(payload as AddressLookupResponse).results.length) {
        setError('No matching Guelph address with nearby transit stops was found yet.');
      }
    } catch (lookupError) {
      if ((lookupError as Error).name === 'AbortError') {
        return;
      }
      setError((lookupError as Error).message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const timer = window.setTimeout(() => {
      void lookupAddress(query);
    }, 450);

    return () => {
      window.clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [lookupAddress, open, query]);

  return (
    <div className="relative rounded-[1.5rem] border border-slate-200/80 bg-slate-50/80 p-3 dark:border-white/10 dark:bg-white/5">
      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">{label}</label>
      <div className="flex items-center rounded-2xl border border-slate-200/80 bg-white/90 px-3 py-2 shadow-sm dark:border-white/10 dark:bg-slate-900/80">
        <MapPinned className="mr-2 h-4 w-4 text-slate-400" />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 120);
          }}
          placeholder="Type a real Guelph street address"
          className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
        />
        {loading ? <div className="text-xs font-semibold text-slate-400">Searching...</div> : null}
      </div>
      <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Start typing an address. The app will resolve it to nearby Guelph transit stops automatically.
      </div>
      {error ? <div className="mt-2 text-sm text-rose-600 dark:text-rose-300">{error}</div> : null}
      {open && results.length ? (
        <div className="absolute inset-x-3 z-[1000] mt-3 max-h-72 overflow-y-auto rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-2xl dark:border-white/10 dark:bg-slate-950/95">
          {results.slice(0, 3).map((result) => (
            <div key={result.id} className="rounded-2xl bg-white/90 p-3 shadow-sm dark:bg-slate-950/70">
              <div className="text-sm font-semibold">{result.displayName}</div>
              {result.nearestStops[0] ? (
                <button
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onSelectStop(result.nearestStops[0]);
                    onSelectAddress?.(result);
                    setQuery(result.displayName);
                    setOpen(false);
                  }}
                  className="mt-3 flex w-full items-center justify-between gap-3 rounded-2xl border border-pine/20 bg-pine/8 px-4 py-3 text-left transition hover:border-pine/45 dark:border-gold/20 dark:bg-gold/10 dark:hover:border-gold/40"
                >
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-pine dark:text-gold">Closest stop</div>
                    <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{result.nearestStops[0].name}</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {result.nearestStops[0].distanceMeters} m away • {formatWalkTime(result.nearestStops[0].walkingMinutes)} • {result.nearestStops[0].routeCount} route{result.nearestStops[0].routeCount === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="text-right text-xs font-semibold text-pine dark:text-gold">
                    {ctaLabel}
                  </div>
                </button>
              ) : null}
              {result.nearestStops.length > 1 ? (
                <div className="mt-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Other nearby stops</div>
                  <div className="flex flex-wrap gap-2">
                    {result.nearestStops.slice(1).map((stop) => (
                      <button
                        key={`${result.id}-${stop.id}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          onSelectStop(stop);
                          onSelectAddress?.(result);
                          setQuery(result.displayName);
                          setOpen(false);
                        }}
                        className="rounded-full border border-slate-200 px-3 py-1.5 text-left text-xs font-semibold text-slate-700 transition hover:border-pine hover:text-pine dark:border-white/10 dark:text-slate-200 dark:hover:border-gold dark:hover:text-gold"
                      >
                        {stop.name} • {stop.distanceMeters} m
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TransitPulseApp() {
  const [theme, setTheme] = usePersistentState<ThemeMode>('gtp-theme', 'dark');
  const [favoriteRouteIds, setFavoriteRouteIds] = usePersistentState<string[]>('gtp-favorite-routes', []);
  const [favoriteStopIds, setFavoriteStopIds] = usePersistentState<string[]>('gtp-favorite-stops', []);
  const [activeRouteIds, setActiveRouteIds] = usePersistentState<string[]>('gtp-route-filters', []);
  const [activeTab, setActiveTab] = useState<TabKey>('search');
  const [selectedStop, setSelectedStop] = useState<TransitStop | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [followedVehicleId, setFollowedVehicleId] = useState<string | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<GeoState>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [searchAddressPin, setSearchAddressPin] = useState<AddressPin>(null);
  const [copilotAddressPin, setCopilotAddressPin] = useState<AddressPin>(null);
  const [copilotLocation, setCopilotLocation] = useState<CopilotLocation>(null);
  const [basemapMode, setBasemapMode] = usePersistentState<BasemapMode>('gtp-basemap', 'street');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const routesQuery = usePollingApi<RouteResponse>('/api/routes', ROUTE_POLL_MS);
  const vehiclesQuery = usePollingApi<VehicleResponse>('/api/vehicles', LIVE_POLL_MS);
  const alertsQuery = usePollingApi<AlertResponse>('/api/alerts', ALERT_POLL_MS);
  const arrivalsQuery = usePollingApi<StopArrivalsResponse>(
    selectedStop ? `/api/stops/${selectedStop.id}/arrivals` : null,
    LIVE_POLL_MS,
    Boolean(selectedStop),
  );
  const nearbyQuery = usePollingApi<NearbyResponse>(
    userLocation ? `/api/nearby?lat=${userLocation.lat}&lng=${userLocation.lng}` : null,
    LIVE_POLL_MS,
    Boolean(userLocation),
  );
  const copilotNearbyQuery = usePollingApi<NearbyResponse>(
    copilotLocation ? `/api/nearby?lat=${copilotLocation.lat}&lng=${copilotLocation.lng}` : null,
    LIVE_POLL_MS,
    Boolean(copilotLocation),
  );

  const routes = routesQuery.data?.data.routes ?? [];
  const vehicles = vehiclesQuery.data?.data.vehicles ?? [];
  const alerts = alertsQuery.data?.data.alerts ?? [];
  const arrivals = arrivalsQuery.data?.data.arrivals ?? [];
  const nearby = nearbyQuery.data?.data.nearby ?? null;
  const copilotNearby = copilotNearbyQuery.data?.data.nearby ?? null;
  const liveRefreshedAt = vehiclesQuery.data?.meta.refreshedAt ?? null;

  const routeMap = useMemo(() => new Map(routes.map((route) => [route.id, route])), [routes]);
  const knownStops = useMemo(() => {
    const map = new Map<string, TransitStop>();
    if (selectedStop) map.set(selectedStop.id, selectedStop);
    arrivalsQuery.data?.data.stop && map.set(arrivalsQuery.data.data.stop.id, arrivalsQuery.data.data.stop);
    nearby?.stops.forEach((stop) => map.set(stop.id, stop));
    copilotNearby?.stops.forEach((stop) => map.set(stop.id, stop));
    return map;
  }, [arrivalsQuery.data?.data.stop, copilotNearby?.stops, nearby?.stops, selectedStop]);

  const favoriteStops = favoriteStopIds.map((stopId) => knownStops.get(stopId)).filter(Boolean) as TransitStop[];
  const contextualHighlights = useMemo<ContextualRouteHighlight[]>(() => {
    if (!selectedStop) {
      return [];
    }

    const targetRouteIds = new Set(selectedStop.routeIds);
    if (targetRouteIds.size === 0) {
      return [];
    }

    const candidateSources =
      copilotNearby?.stops?.[0] && copilotNearby.stops[0].id !== selectedStop.id
        ? [
            {
              stop: copilotNearby.stops[0],
              reason: 'origin-stop' as const,
              distanceMeters: copilotNearby.stops[0].distanceMeters,
              nextArrival: copilotNearby.stops[0].nextArrival,
            },
          ]
        : (nearby?.stops ?? [])
            .filter((stop) => stop.id !== selectedStop.id)
            .map((stop) => ({
              stop,
              reason: 'nearby-stop' as const,
              distanceMeters: stop.distanceMeters,
              nextArrival: stop.nextArrival,
            }));

    const bestByRoute = new Map<string, ContextualRouteHighlight>();

    candidateSources.forEach((source) => {
      source.stop.routeIds
        .filter((routeId) => targetRouteIds.has(routeId))
        .forEach((routeId) => {
          const route = routeMap.get(routeId);
          const matchingArrival =
            source.nextArrival?.routeId === routeId ? source.nextArrival : null;

          const nextHighlight: ContextualRouteHighlight = {
            routeId,
            routeShortName: route?.shortName || routeId,
            routeColor: route?.color || matchingArrival?.routeColor || '#0A9396',
            routeTextColor: route?.textColor || matchingArrival?.routeTextColor || '#FFFFFF',
            sourceStopId: source.stop.id,
            sourceStopName: source.stop.name,
            targetStopId: selectedStop.id,
            targetStopName: selectedStop.name,
            distanceMeters: source.distanceMeters,
            nextDepartureEtaMinutes: matchingArrival?.etaMinutes ?? null,
            nextDepartureTime: matchingArrival?.estimatedDeparture ?? null,
            headsign: matchingArrival?.headsign ?? null,
            reason: source.reason,
          };

          const current = bestByRoute.get(routeId);
          if (!current) {
            bestByRoute.set(routeId, nextHighlight);
            return;
          }

          const nextScore =
            (nextHighlight.reason === 'origin-stop' ? 100000 : 0) -
            (nextHighlight.nextDepartureEtaMinutes ?? 9999) -
            ((nextHighlight.distanceMeters ?? 0) / 100);
          const currentScore =
            (current.reason === 'origin-stop' ? 100000 : 0) -
            (current.nextDepartureEtaMinutes ?? 9999) -
            ((current.distanceMeters ?? 0) / 100);

          if (nextScore > currentScore) {
            bestByRoute.set(routeId, nextHighlight);
          }
        });
    });

    return Array.from(bestByRoute.values()).sort((a, b) => {
      if (a.reason !== b.reason) {
        return a.reason === 'origin-stop' ? -1 : 1;
      }
      if ((a.nextDepartureEtaMinutes ?? Number.MAX_SAFE_INTEGER) !== (b.nextDepartureEtaMinutes ?? Number.MAX_SAFE_INTEGER)) {
        return (a.nextDepartureEtaMinutes ?? Number.MAX_SAFE_INTEGER) - (b.nextDepartureEtaMinutes ?? Number.MAX_SAFE_INTEGER);
      }
      return (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER);
    });
  }, [copilotNearby?.stops, nearby?.stops, routeMap, selectedStop]);
  const contextualRouteIds = contextualHighlights.map((highlight) => highlight.routeId);
  const filteredVehicles = activeRouteIds.length
    ? vehicles.filter((vehicle) => vehicle.routeId && activeRouteIds.includes(vehicle.routeId))
    : vehicles;
  const highlightedStops = useMemo(() => {
    const items = new Map<string, TransitStop>();
    if (selectedStop) items.set(selectedStop.id, selectedStop);
    nearby?.stops.forEach((stop) => items.set(stop.id, stop));
    favoriteStops.forEach((stop) => items.set(stop.id, stop));
    return Array.from(items.values());
  }, [favoriteStops, nearby?.stops, selectedStop]);
  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? null;
  const bestNextDeparture = nearby?.bestDeparture ?? arrivals[0] ?? null;
  const filteredAlerts = alerts.filter((alert) => {
    const scopedRouteIds = activeRouteIds.length ? activeRouteIds : favoriteRouteIds;
    if (scopedRouteIds.length === 0) {
      return true;
    }
    return alert.routeIds.length === 0 || alert.routeIds.some((routeId) => scopedRouteIds.includes(routeId));
  });
  const meta = collectMeta(routesQuery.data?.meta, vehiclesQuery.data?.meta, alertsQuery.data?.meta, arrivalsQuery.data?.meta, nearbyQuery.data?.meta, copilotNearbyQuery.data?.meta);
  const selectedRoute = useMemo(
    () => routes.find((route) => route.id === selectedRouteId) ?? null,
    [routes, selectedRouteId],
  );
  const addressPins = useMemo(
    () => [searchAddressPin, copilotAddressPin].filter(Boolean) as Array<NonNullable<AddressPin>>,
    [copilotAddressPin, searchAddressPin],
  );

  useEffect(() => {
    if (selectedRouteId && !routes.some((route) => route.id === selectedRouteId)) {
      setSelectedRouteId(null);
    }
  }, [routes, selectedRouteId]);

  const toggleRouteFavorite = (routeId: string) => {
    setFavoriteRouteIds((current) =>
      current.includes(routeId) ? current.filter((value) => value !== routeId) : [...current, routeId],
    );
  };

  const toggleStopFavorite = (stopId: string) => {
    setFavoriteStopIds((current) =>
      current.includes(stopId) ? current.filter((value) => value !== stopId) : [...current, stopId],
    );
  };

  const selectRouteHighlight = (routeId: string) => {
    setSelectedRouteId((current) => (current === routeId ? null : routeId));
    setActiveRouteIds((current) =>
      current.includes(routeId) ? current.filter((value) => value !== routeId) : [...current, routeId],
    );
  };

  const clearRouteFilters = () => {
    setActiveRouteIds([]);
    setSelectedRouteId(null);
  };

  const highlightedRoutePath = selectedRoute?.shapePaths.length ? selectedRoute.shapePaths : [];
  const highlightedRouteColor = selectedRoute?.color ?? null;

  const requestLocation = () => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not available in this browser.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({ lat: position.coords.latitude, lng: position.coords.longitude });
        setLocationError(null);
      },
      (error) => {
        setLocationError(error.message || 'Location permission was denied.');
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 },
    );
  };

  const requestCopilotLocation = () => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not available in this browser.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
        setUserLocation(nextLocation);
        setCopilotLocation({
          ...nextLocation,
          label: 'Your live location',
          source: 'device',
        });
        setCopilotAddressPin({
          id: 'copilot-device',
          label: 'Your live location',
          lat: nextLocation.lat,
          lng: nextLocation.lng,
          tone: 'search',
        });
        setLocationError(null);
      },
      (error) => {
        setLocationError(error.message || 'Location permission was denied.');
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 },
    );
  };

  const topSummaryTone = bestNextDeparture
    ? bestNextDeparture.delaySeconds >= 180
      ? 'from-rose-500/90 to-orange-500/90'
      : 'from-emerald-500/90 to-teal-500/90'
    : 'from-slate-700/90 to-slate-500/90';

  return (
    <div className="min-h-screen bg-paper bg-grain text-ink dark:bg-ink dark:text-paper">
      <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col px-4 pb-32 pt-4 sm:px-6 lg:px-8 lg:pb-8 lg:pt-6">
        <header className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.24em] text-pine/70 dark:text-gold/80">Guelph, Ontario</div>
            <h1 className="mt-2 text-4xl font-black tracking-tight sm:text-5xl">Guelph Transit Pulse</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-700 dark:text-slate-300">
              Mobile-first live transit tracking built around the official City of Guelph GTFS and GTFS-Realtime feeds.
            </p>
            <p className="mt-2 max-w-2xl text-xs text-slate-500 dark:text-slate-400">
              Unofficial app. Not affiliated with the City of Guelph or Guelph Transit.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-full border border-white/50 bg-white/85 px-4 py-2 text-sm font-semibold shadow-sm backdrop-blur dark:border-white/10 dark:bg-slate-950/75">
              <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">Live refresh</div>
              <div className="text-slate-900 dark:text-white">{formatRefreshCountdown(vehiclesQuery.secondsUntilRefresh, vehiclesQuery.loading)}</div>
            </div>
            <div className={clsx('rounded-full border px-4 py-2 text-sm font-semibold shadow-sm backdrop-blur', mlBadgeTone(meta))}>
              <div className="text-[11px] uppercase tracking-[0.16em] opacity-80">Transit copilot</div>
              <div>{mlBadgeLabel(meta)}</div>
            </div>
            <button
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              className="inline-flex items-center gap-2 rounded-full border border-white/50 bg-white/80 px-4 py-2 text-sm font-semibold shadow-sm backdrop-blur dark:border-white/10 dark:bg-slate-950/75"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
            <button
              onClick={() => {
                void routesQuery.refresh();
                void vehiclesQuery.refresh();
                void alertsQuery.refresh();
                void arrivalsQuery.refresh();
                void nearbyQuery.refresh();
                void copilotNearbyQuery.refresh();
              }}
              className="inline-flex items-center gap-2 rounded-full border border-white/50 bg-white/80 px-4 py-2 text-sm font-semibold shadow-sm backdrop-blur dark:border-white/10 dark:bg-slate-950/75"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </header>

        {meta && (!meta.configured || meta.warnings.length > 0 || meta.errors.length > 0) ? (
          <div className="mb-4 rounded-[1.5rem] border border-amber-300/70 bg-amber-50/90 p-4 text-sm text-amber-950 shadow-sm dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-100">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="space-y-1">
                {!meta.configured ? (
                  <div>
                    Feed URLs are not configured. Add the official City of Guelph URLs to `GTFS_STATIC_URL`, `GTFS_RT_VEHICLE_POSITIONS_URL`, `GTFS_RT_TRIP_UPDATES_URL`, and `GTFS_RT_ALERTS_URL`.
                  </div>
                ) : null}
                {meta.warnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
                {meta.errors.map((error) => (
                  <div key={error}>{error}</div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-6">
          <div className="space-y-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
              <div className="rounded-[1.5rem] border border-white/50 bg-white/88 px-4 py-3 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-950/82">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Live map</div>
                <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">Guelph Transit Pulse</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Official GTFS-Realtime vehicles on {basemapMode === 'street' ? 'OpenStreetMap' : 'satellite imagery'}
                </div>
              </div>
              <div className="rounded-[1.5rem] border border-white/50 bg-white/92 px-3 py-3 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-950/88">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  Map view
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setBasemapMode('street')}
                    className={clsx(
                      'rounded-xl border px-4 py-2 text-xs font-bold shadow-sm transition',
                      basemapMode === 'street'
                        ? 'border-pine bg-pine text-white dark:border-gold dark:bg-gold dark:text-slate-950'
                        : 'border-slate-200 bg-slate-100 text-slate-700 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200',
                    )}
                  >
                    Street
                  </button>
                  <button
                    onClick={() => setBasemapMode('satellite')}
                    className={clsx(
                      'rounded-xl border px-4 py-2 text-xs font-bold shadow-sm transition',
                      basemapMode === 'satellite'
                        ? 'border-pine bg-pine text-white dark:border-gold dark:bg-gold dark:text-slate-950'
                        : 'border-slate-200 bg-slate-100 text-slate-700 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200',
                    )}
                  >
                    Satellite
                  </button>
                </div>
              </div>
              <div className="rounded-[1.5rem] border border-white/50 bg-white/88 px-4 py-3 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-950/82">
                <div className="text-sm font-semibold text-slate-900 dark:text-white">{filteredVehicles.length} buses</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {vehiclesQuery.loading
                    ? 'Refreshing live positions...'
                    : vehiclesQuery.secondsUntilRefresh !== null
                      ? `Next update in ${vehiclesQuery.secondsUntilRefresh}s`
                      : 'Animated between refreshes'}
                </div>
                <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                  {liveRefreshedAt
                    ? `Last feed ${new Intl.DateTimeFormat('en-CA', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(liveRefreshedAt))}`
                    : 'Waiting for live feed'}
                </div>
              </div>
            </div>
            <div className="relative h-[52vh] min-h-[390px] lg:h-[calc(100vh-14rem)]">
            <TransitMap
              vehicles={filteredVehicles}
              highlightedStops={highlightedStops}
              addressPins={addressPins}
              basemapMode={basemapMode}
              contextualRouteIds={contextualRouteIds}
              highlightedRoutePaths={highlightedRoutePath}
              highlightedRouteColor={highlightedRouteColor}
              selectedStop={selectedStop}
              selectedVehicleId={selectedVehicleId}
              followedVehicleId={followedVehicleId}
              userLocation={userLocation}
              defaultCenter={DEFAULT_CENTER}
              defaultZoom={DEFAULT_ZOOM}
              refreshIntervalMs={LIVE_POLL_MS}
              onSelectStop={(stop) => {
                setSelectedStop(stop);
                setActiveTab('search');
              }}
              onSelectVehicle={(vehicleId) => {
                setSelectedVehicleId(vehicleId);
                setActiveTab('nearby');
              }}
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-4 px-4">
              <div className={clsx('pointer-events-auto rounded-[1.8rem] bg-gradient-to-r p-[1px] shadow-2xl backdrop-blur', topSummaryTone)}>
                <div className="rounded-[1.7rem] bg-slate-950/88 px-5 py-4 text-white">
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-white/65">Most reliable next departure</div>
                  {bestNextDeparture ? (
                    <div className="mt-2 flex items-end justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <span
                            className="rounded-full px-2 py-1 text-xs font-black"
                            style={{ backgroundColor: bestNextDeparture.routeColor, color: bestNextDeparture.routeTextColor }}
                          >
                            {compactRouteLabel(bestNextDeparture.routeShortName, bestNextDeparture.headsign)}
                          </span>
                          <span className="text-sm text-white/80">{delayLabel(bestNextDeparture)}</span>
                          <span className="rounded-full bg-white/15 px-2 py-1 text-[11px] font-semibold text-white/90">
                            {bestNextDeparture.confidenceLevel} confidence
                          </span>
                          {usesMlAssist(bestNextDeparture.reasons) ? (
                            <span className="rounded-full bg-cyan-400/20 px-2 py-1 text-[11px] font-semibold text-cyan-100">
                              ML-assisted
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 text-xl font-bold">{bestNextDeparture.headsign}</div>
                        <div className="mt-2 text-sm text-white/70">{bestNextDeparture.reasons[0] ?? 'Live trip analysis unavailable'}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-3xl font-black">{formatRelativeMinutes(bestNextDeparture.etaMinutes)}</div>
                        <div className="text-sm text-white/70">{formatTime(bestNextDeparture.estimatedDeparture)}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 text-sm text-white/75">Enable location or pick a stop to surface the best next departure.</div>
                  )}
                </div>
              </div>
            </div>
            </div>
          </div>

          <div className="hidden max-h-[calc(100vh-11rem)] space-y-4 overflow-y-auto pr-1 lg:block">
            <DesktopPanels
              routes={routes}
              routeMap={routeMap}
              favoriteRouteIds={favoriteRouteIds}
              activeRouteIds={activeRouteIds}
              selectedRouteId={selectedRouteId}
              favoriteStops={favoriteStops}
              contextualHighlights={contextualHighlights}
              selectedStop={selectedStop}
              arrivals={arrivals}
              nearby={nearby}
              copilotNearby={copilotNearby}
              copilotLocation={copilotLocation}
              selectedVehicle={selectedVehicle}
              followedVehicleId={followedVehicleId}
              filteredAlerts={filteredAlerts}
              locationError={locationError}
              requestLocation={requestLocation}
              requestCopilotLocation={requestCopilotLocation}
              setSelectedStop={setSelectedStop}
              setSearchAddressPin={setSearchAddressPin}
              setCopilotAddressPin={setCopilotAddressPin}
              setCopilotLocation={setCopilotLocation}
              toggleStopFavorite={toggleStopFavorite}
              toggleRouteFavorite={toggleRouteFavorite}
              clearRouteFilters={clearRouteFilters}
              selectRouteHighlight={selectRouteHighlight}
              setFollowedVehicleId={setFollowedVehicleId}
            />
          </div>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-[1200] p-3 lg:hidden">
        <div className="mx-auto max-w-3xl rounded-[2rem] border border-white/45 bg-white/92 p-3 shadow-2xl backdrop-blur dark:border-white/10 dark:bg-slate-950/88">
          <div className="mb-3 grid grid-cols-4 gap-2">
            {[
              ['search', 'Stops'],
              ['nearby', 'Nearby'],
              ['alerts', 'Alerts'],
              ['copilot', 'Health'],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key as TabKey)}
                className={clsx(
                  'rounded-2xl px-3 py-2 text-sm font-semibold transition',
                  activeTab === key ? 'bg-pine text-white' : 'bg-slate-100 text-slate-600 dark:bg-white/5 dark:text-slate-300',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="max-h-[46vh] overflow-y-auto">
            <MobilePanel
              activeTab={activeTab}
              routes={routes}
              routeMap={routeMap}
              favoriteRouteIds={favoriteRouteIds}
              activeRouteIds={activeRouteIds}
              selectedRouteId={selectedRouteId}
              favoriteStops={favoriteStops}
              contextualHighlights={contextualHighlights}
              selectedStop={selectedStop}
              arrivals={arrivals}
              nearby={nearby}
              copilotNearby={copilotNearby}
              copilotLocation={copilotLocation}
              selectedVehicle={selectedVehicle}
              followedVehicleId={followedVehicleId}
              filteredAlerts={filteredAlerts}
              locationError={locationError}
              requestLocation={requestLocation}
              requestCopilotLocation={requestCopilotLocation}
              setSelectedStop={setSelectedStop}
              setSearchAddressPin={setSearchAddressPin}
              setCopilotAddressPin={setCopilotAddressPin}
              setCopilotLocation={setCopilotLocation}
              toggleStopFavorite={toggleStopFavorite}
              toggleRouteFavorite={toggleRouteFavorite}
              clearRouteFilters={clearRouteFilters}
              selectRouteHighlight={selectRouteHighlight}
              setFollowedVehicleId={setFollowedVehicleId}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function DesktopPanels(props: PanelProps) {
  return (
    <>
      <SearchPanel {...props} />
      <RoutesPanel {...props} />
      <NearbyPanel {...props} />
      <AlertsPanel alerts={props.filteredAlerts} />
      <RouteHealthBoard {...props} />
      <FollowPanel {...props} />
    </>
  );
}

function MobilePanel({ activeTab, ...props }: { activeTab: TabKey } & PanelProps) {
  if (activeTab === 'search') {
    return (
      <div className="space-y-3">
        <SearchPanel {...props} />
        <RoutesPanel {...props} />
      </div>
    );
  }
  if (activeTab === 'nearby') {
    return (
      <div className="space-y-3">
        <NearbyPanel {...props} />
        <FollowPanel {...props} />
      </div>
    );
  }
  if (activeTab === 'alerts') {
    return <AlertsPanel alerts={props.filteredAlerts} />;
  }
  return <RouteHealthBoard {...props} />;
}

type PanelProps = {
  routes: TransitRoute[];
  routeMap: Map<string, TransitRoute>;
  favoriteRouteIds: string[];
  activeRouteIds: string[];
  selectedRouteId: string | null;
  favoriteStops: TransitStop[];
  contextualHighlights: ContextualRouteHighlight[];
  selectedStop: TransitStop | null;
  arrivals: TransitArrival[];
  nearby: NearbyResponse['nearby'] | null;
  copilotNearby: NearbyResponse['nearby'] | null;
  copilotLocation: CopilotLocation;
  selectedVehicle: TransitVehicle | null;
  followedVehicleId: string | null;
  filteredAlerts: TransitAlert[];
  locationError: string | null;
  requestLocation: () => void;
  requestCopilotLocation: () => void;
  setSelectedStop: (stop: TransitStop) => void;
  setSearchAddressPin: (pin: AddressPin) => void;
  setCopilotAddressPin: (pin: AddressPin) => void;
  setCopilotLocation: (location: CopilotLocation) => void;
  toggleStopFavorite: (stopId: string) => void;
  toggleRouteFavorite: (routeId: string) => void;
  clearRouteFilters: () => void;
  selectRouteHighlight: (routeId: string) => void;
  setFollowedVehicleId: (vehicleId: string | null | ((current: string | null) => string | null)) => void;
};

function SearchPanel({
  selectedStop,
  arrivals,
  favoriteStops,
  contextualHighlights,
  setSelectedStop,
  setSearchAddressPin,
  toggleStopFavorite,
}: PanelProps) {
  return (
    <SectionCard title="Stop search" subtitle="Search by stop name, stop code, or home address, then inspect live arrivals." icon={<Search className="h-5 w-5" />}>
      <div className="space-y-4">
        <StopPicker
          label="Find a stop"
          selectedStop={selectedStop}
          onSelect={(stop) => {
            setSelectedStop(stop);
            setSearchAddressPin(null);
          }}
        />
        <AddressLookupPicker
          label="Find stop by address"
          ctaLabel="Show stop"
          onSelectStop={setSelectedStop}
          onSelectAddress={(result) =>
            setSearchAddressPin({
              id: `search-${result.id}`,
              label: result.displayName,
              lat: result.lat,
              lng: result.lng,
              tone: 'search',
            })
          }
        />
        {favoriteStops.length ? (
          <div className="flex flex-wrap gap-2">
            {favoriteStops.map((stop) => (
              <button
                key={stop.id}
                onClick={() => setSelectedStop(stop)}
                className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:border-white/10 dark:text-slate-200"
              >
                {stop.name}
              </button>
            ))}
          </div>
        ) : null}
        {selectedStop ? (
          <div className="rounded-[1.5rem] bg-slate-900/5 p-4 dark:bg-white/5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-bold">{selectedStop.name}</div>
                <div className="text-sm text-slate-500">Stop {selectedStop.code}</div>
              </div>
              <button
                onClick={() => toggleStopFavorite(selectedStop.id)}
                className="rounded-full bg-white/80 p-2 text-slate-700 shadow-sm dark:bg-white/10 dark:text-white"
                aria-label="Toggle favorite stop"
              >
                <Star className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {contextualHighlights.length ? (
                <div className="rounded-2xl border border-pine/20 bg-pine/10 p-3 dark:border-gold/20 dark:bg-gold/10">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-pine dark:text-gold">
                    <Navigation className="h-4 w-4" />
                    Best route from your side of town
                  </div>
                  <div className="mt-3 space-y-2">
                    {contextualHighlights.slice(0, 3).map((highlight) => (
                      <div key={`${highlight.sourceStopId}-${highlight.routeId}`} className="rounded-2xl bg-white/80 px-3 py-3 shadow-sm dark:bg-slate-950/70">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full px-2 py-1 text-xs font-black" style={{ backgroundColor: highlight.routeColor, color: highlight.routeTextColor }}>
                              {compactRouteLabel(highlight.routeShortName, highlight.headsign)}
                            </span>
                            <span className="text-sm font-semibold">
                              {highlight.sourceStopName} to {highlight.targetStopName}
                            </span>
                          </div>
                          <div className="text-right text-xs text-slate-500 dark:text-slate-400">
                            {highlight.nextDepartureEtaMinutes !== null ? formatRelativeMinutes(highlight.nextDepartureEtaMinutes) : highlight.reason === 'origin-stop' ? 'Direct route' : 'Nearby option'}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                          <span>{highlight.reason === 'origin-stop' ? 'Using your chosen origin stop' : `${highlight.distanceMeters ?? 0} m from you`}</span>
                          <span>{highlight.headsign ?? 'Direct route serving this stop'}</span>
                          {highlight.nextDepartureTime ? <span>{formatTime(highlight.nextDepartureTime)}</span> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {arrivals.slice(0, 6).map((arrival) => (
                <div key={`${arrival.tripId}-${arrival.estimatedDeparture}`} className="rounded-2xl bg-white/80 p-3 shadow-sm dark:bg-slate-950/70">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full px-2 py-1 text-xs font-black" style={{ backgroundColor: arrival.routeColor, color: arrival.routeTextColor }}>
                        {compactRouteLabel(arrival.routeShortName, arrival.headsign)}
                      </span>
                      <span className="text-sm font-semibold">{arrival.headsign}</span>
                    </div>
                    <div className="text-right text-sm font-bold">{formatRelativeMinutes(arrival.etaMinutes)}</div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className={clsx('rounded-full px-2 py-1 text-[11px] font-semibold', confidenceTone(arrival.confidenceLevel))}>
                      {arrival.confidenceLevel} {arrival.confidenceScore}
                    </span>
                    <span className={clsx('rounded-full px-2 py-1 text-[11px] font-semibold', recommendationTone(arrival.recommendation))}>
                      {recommendationLabel(arrival.recommendation)}
                    </span>
                    {usesMlAssist(arrival.reasons) ? (
                      <span className="rounded-full bg-cyan-500/15 px-2 py-1 text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">
                        ML-assisted
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>{formatTime(arrival.estimatedDeparture)}</span>
                    <span>{delayLabel(arrival)}</span>
                    <span>{arrival.stopsAway !== null ? `${arrival.stopsAway} stops away` : arrival.isRealtime ? 'Live' : 'Schedule'}</span>
                  </div>
                  <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    {arrival.reasons.slice(0, 2).join(' • ')}
                  </div>
                </div>
              ))}
              {!arrivals.length ? <div className="text-sm text-slate-500">No upcoming departures found for this stop.</div> : null}
            </div>
          </div>
        ) : (
          <div className="rounded-[1.5rem] border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
            Pick a stop to see live arrivals, ETA, route color, and how many stops away the next bus is.
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function RoutesPanel({
  routes,
  favoriteRouteIds,
  activeRouteIds,
  selectedRouteId,
  contextualHighlights,
  toggleRouteFavorite,
  clearRouteFilters,
  selectRouteHighlight,
}: PanelProps) {
  const contextualRouteSet = new Set(contextualHighlights.map((highlight) => highlight.routeId));
  return (
    <SectionCard title="Routes" subtitle="Filter the map and keep favorite lines pinned." icon={<Route className="h-5 w-5" />}>
      <div className="space-y-3">
        {activeRouteIds.length ? (
          <button onClick={clearRouteFilters} className="text-xs font-semibold text-pine dark:text-gold">
            Clear route filters
          </button>
        ) : null}
        <div className="grid gap-2">
          {routes.map((route) => {
            const favorite = favoriteRouteIds.includes(route.id);
            const active = activeRouteIds.includes(route.id);
            const selected = selectedRouteId === route.id;
            const contextual = contextualRouteSet.has(route.id);
            return (
              <div
                key={route.id}
                className={clsx(
                  'rounded-2xl border p-3 transition',
                  selected
                    ? 'border-accent bg-accent/10 ring-2 ring-accent/35'
                    : active
                    ? 'border-pine bg-pine/5 dark:border-gold/40 dark:bg-gold/10'
                    : contextual
                      ? 'border-accent/50 bg-accent/5 dark:border-accent/40 dark:bg-accent/10'
                      : 'border-slate-200 dark:border-white/10',
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <button onClick={() => selectRouteHighlight(route.id)} className="flex items-center gap-3 text-left">
                    <span className="rounded-full px-2.5 py-1 text-xs font-black" style={{ backgroundColor: route.color, color: route.textColor }}>
                      {route.shortName}
                    </span>
                    <span>
                      <span className="block text-sm font-semibold">{route.longName}</span>
                      <span className="flex flex-wrap gap-2">
                        <span className={clsx('inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold', reliabilityTone(route))}>{reliabilityLabel(route)}</span>
                        {selected ? (
                          <span className="inline-flex rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">
                            Highlighted on map
                          </span>
                        ) : null}
                        {contextual ? (
                          <span className="inline-flex rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">
                            Best for selected stop
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                  <button onClick={() => toggleRouteFavorite(route.id)} className={clsx('rounded-full p-2', favorite ? 'text-accent' : 'text-slate-400')}>
                    <Heart className={clsx('h-4 w-4', favorite ? 'fill-current' : '')} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </SectionCard>
  );
}

function NearbyPanel({ nearby, requestLocation, locationError }: PanelProps) {
  return (
    <SectionCard title="Nearby transit" subtitle="Find the fastest departures around you." icon={<LocateFixed className="h-5 w-5" />}>
      <div className="space-y-4">
        <button onClick={requestLocation} className="inline-flex items-center gap-2 rounded-full bg-pine px-4 py-2 text-sm font-semibold text-white dark:bg-gold dark:text-slate-950">
          <Compass className="h-4 w-4" />
          Use my location
        </button>
        {locationError ? <div className="text-sm text-rose-600 dark:text-rose-300">{locationError}</div> : null}
        {nearby ? (
          <div className="space-y-3">
            <div className="rounded-[1.5rem] bg-slate-900/5 p-4 dark:bg-white/5">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Closest stops</div>
              <div className="mt-3 space-y-3">
                {nearby.stops.slice(0, 4).map((stop) => (
                  <div key={stop.id} className="flex items-center justify-between gap-3 rounded-2xl bg-white/80 px-3 py-3 text-sm shadow-sm dark:bg-slate-950/70">
                    <div>
                      <div className="font-semibold">{stop.name}</div>
                      <div className="text-xs text-slate-500">{stop.distanceMeters} m away</div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold">{stop.nextArrival ? formatRelativeMinutes(stop.nextArrival.etaMinutes) : 'No live trip'}</div>
                      <div className="text-xs text-slate-500">{stop.nextArrival?.routeShortName ?? 'Check stop'}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-[1.5rem] bg-slate-900/5 p-4 dark:bg-white/5">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Nearby buses</div>
              <div className="mt-3 space-y-3">
                {nearby.vehicles.slice(0, 4).map((vehicle) => (
                  <div key={vehicle.id} className="flex items-center justify-between gap-3 rounded-2xl bg-white/80 px-3 py-3 text-sm shadow-sm dark:bg-slate-950/70">
                    <div>
                      <div className="font-semibold">Route {vehicle.routeShortName}</div>
                      <div className="text-xs text-slate-500">{vehicle.headsign}</div>
                    </div>
                    <div className="text-right text-xs text-slate-500">
                      <div>{vehicle.distanceMeters} m away</div>
                      <div>{vehicle.nextStopName ?? 'Next stop unavailable'}</div>
                    </div>
                  </div>
                ))}
                {!nearby.vehicles.length ? <div className="text-sm text-slate-500">No active buses nearby right now.</div> : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-[1.5rem] border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
            Location stays in your browser. If permission is denied, the app still works with manual stop search.
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function AlertsPanel({ alerts }: { alerts: TransitAlert[] }) {
  return (
    <SectionCard title="Alerts" subtitle="Official service notices from the GTFS-Realtime alerts feed." icon={<Bell className="h-5 w-5" />}>
      <details className="group rounded-[1.5rem] border border-slate-200/80 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-white/5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">{alerts.length ? `${alerts.length} active alert${alerts.length === 1 ? '' : 's'}` : 'No active alerts'}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Expand only when you need disruption details.</div>
          </div>
          <span className="text-xs font-semibold text-pine transition group-open:rotate-180 dark:text-gold">⌄</span>
        </summary>
        <div className="mt-4 space-y-3">
          {alerts.map((alert) => (
            <div key={alert.id} className="rounded-[1.5rem] border border-amber-300/60 bg-amber-50/80 p-4 dark:border-amber-400/15 dark:bg-amber-500/10">
              <div className="text-sm font-bold">{alert.header}</div>
              <div className="mt-1 text-sm text-slate-700 dark:text-slate-300">{alert.description || 'Details are limited in the current alert feed.'}</div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-white/80 px-2 py-1 dark:bg-white/10">{alert.effect.replaceAll('_', ' ')}</span>
                {alert.routeIds.slice(0, 4).map((routeId) => (
                  <span key={routeId} className="rounded-full bg-white/80 px-2 py-1 dark:bg-white/10">Route {routeId}</span>
                ))}
              </div>
            </div>
          ))}
          {!alerts.length ? <div className="text-sm text-slate-500">No current alerts for your selected or favorite routes.</div> : null}
        </div>
      </details>
    </SectionCard>
  );
}

function RouteHealthBoard({
  routes,
  favoriteRouteIds,
  filteredAlerts,
  selectRouteHighlight,
  toggleRouteFavorite,
}: PanelProps) {
  const rankedRoutes = useMemo(() => {
    const alertCounts = new Map<string, number>();
    filteredAlerts.forEach((alert) => {
      alert.routeIds.forEach((routeId) => {
        alertCounts.set(routeId, (alertCounts.get(routeId) ?? 0) + 1);
      });
    });

    const healthWeight = (route: TransitRoute) => {
      switch (route.reliability.status) {
        case 'strong':
          return 3;
        case 'watch':
          return 2;
        case 'scheduled-only':
          return 1;
        case 'disrupted':
          return 0;
        default:
          return 0;
      }
    };

    return routes
      .map((route) => ({
        route,
        alertCount: alertCounts.get(route.id) ?? 0,
        score:
          healthWeight(route) * 100 -
          route.reliability.averageDelayMinutes * 8 -
          route.reliability.staleVehicles * 5 -
          (alertCounts.get(route.id) ?? 0) * 14 +
          route.reliability.activeVehicles * 3,
      }))
      .sort((left, right) => right.score - left.score);
  }, [filteredAlerts, routes]);

  const strongRoutes = rankedRoutes.filter((entry) => entry.route.reliability.status === 'strong').slice(0, 4);
  const watchRoutes = rankedRoutes.filter((entry) => entry.route.reliability.status === 'watch').slice(0, 4);
  const disruptedRoutes = rankedRoutes.filter((entry) => entry.route.reliability.status === 'disrupted').slice(0, 4);

  const RouteCard = ({
    route,
    alertCount,
    emphasis,
  }: {
    route: TransitRoute;
    alertCount: number;
    emphasis: 'strong' | 'watch' | 'disrupted';
  }) => {
    const favorite = favoriteRouteIds.includes(route.id);
    return (
      <div
        className={clsx(
          'rounded-[1.4rem] border p-4 shadow-sm transition',
          emphasis === 'strong'
            ? 'border-emerald-300/50 bg-emerald-50/75 dark:border-emerald-400/20 dark:bg-emerald-500/10'
            : emphasis === 'watch'
              ? 'border-amber-300/50 bg-amber-50/75 dark:border-amber-400/20 dark:bg-amber-500/10'
              : 'border-rose-300/50 bg-rose-50/75 dark:border-rose-400/20 dark:bg-rose-500/10',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <button onClick={() => selectRouteHighlight(route.id)} className="flex items-start gap-3 text-left">
            <span className="rounded-full px-2.5 py-1 text-xs font-black" style={{ backgroundColor: route.color, color: route.textColor }}>
              {route.shortName}
            </span>
            <span>
              <span className="block text-sm font-semibold">{route.longName}</span>
              <span className="mt-1 flex flex-wrap gap-2 text-xs">
                <span className={clsx('rounded-full px-2 py-0.5 font-semibold', reliabilityTone(route))}>{reliabilityLabel(route)}</span>
                {alertCount > 0 ? (
                  <span className="rounded-full bg-slate-900/8 px-2 py-0.5 font-semibold text-slate-700 dark:bg-white/10 dark:text-slate-200">
                    {alertCount} alert{alertCount === 1 ? '' : 's'}
                  </span>
                ) : null}
              </span>
            </span>
          </button>
          <button onClick={() => toggleRouteFavorite(route.id)} className={clsx('rounded-full p-2', favorite ? 'text-accent' : 'text-slate-400')}>
            <Heart className={clsx('h-4 w-4', favorite ? 'fill-current' : '')} />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs text-slate-600 dark:text-slate-300">
          <div className="rounded-xl bg-white/70 px-2 py-2 dark:bg-slate-950/60">
            <div className="uppercase tracking-[0.12em] text-[10px] text-slate-500 dark:text-slate-400">Avg delay</div>
            <div className="mt-1 font-bold">{route.reliability.averageDelayMinutes.toFixed(1)} min</div>
          </div>
          <div className="rounded-xl bg-white/70 px-2 py-2 dark:bg-slate-950/60">
            <div className="uppercase tracking-[0.12em] text-[10px] text-slate-500 dark:text-slate-400">Live buses</div>
            <div className="mt-1 font-bold">{route.reliability.activeVehicles}</div>
          </div>
          <div className="rounded-xl bg-white/70 px-2 py-2 dark:bg-slate-950/60">
            <div className="uppercase tracking-[0.12em] text-[10px] text-slate-500 dark:text-slate-400">Stale</div>
            <div className="mt-1 font-bold">{route.reliability.staleVehicles}</div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <SectionCard
      title="Route Health Board"
      subtitle="See which Guelph routes are running strongest right now, which ones need caution, and which ones look disrupted."
      icon={<Radar className="h-5 w-5" />}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-[1.4rem] bg-emerald-50/75 p-4 dark:bg-emerald-500/10">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">Strong now</div>
            <div className="mt-2 text-2xl font-black text-emerald-800 dark:text-emerald-200">{strongRoutes.length}</div>
            <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">Routes with low delay and fresh tracking.</div>
          </div>
          <div className="rounded-[1.4rem] bg-amber-50/75 p-4 dark:bg-amber-500/10">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">Watch</div>
            <div className="mt-2 text-2xl font-black text-amber-800 dark:text-amber-200">{watchRoutes.length}</div>
            <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">Routes with moderate delay or tracking risk.</div>
          </div>
          <div className="rounded-[1.4rem] bg-rose-50/75 p-4 dark:bg-rose-500/10">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rose-700 dark:text-rose-300">Disrupted</div>
            <div className="mt-2 text-2xl font-black text-rose-800 dark:text-rose-200">{disruptedRoutes.length}</div>
            <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">Routes showing higher live delay or stale feed issues.</div>
          </div>
        </div>

        <div className="rounded-[1.5rem] bg-slate-900/5 p-4 dark:bg-white/5">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Best routes to trust right now</div>
          <div className="mt-3 space-y-3">
            {strongRoutes.length ? strongRoutes.map(({ route, alertCount }) => (
              <RouteCard key={`strong-${route.id}`} route={route} alertCount={alertCount} emphasis="strong" />
            )) : <div className="text-sm text-slate-500">No routes are currently scoring as strong.</div>}
          </div>
        </div>

        <div className="rounded-[1.5rem] bg-slate-900/5 p-4 dark:bg-white/5">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Routes to watch</div>
          <div className="mt-3 space-y-3">
            {watchRoutes.length ? watchRoutes.map(({ route, alertCount }) => (
              <RouteCard key={`watch-${route.id}`} route={route} alertCount={alertCount} emphasis="watch" />
            )) : <div className="text-sm text-slate-500">No routes are currently in the watch band.</div>}
          </div>
        </div>

        {disruptedRoutes.length ? (
          <div className="rounded-[1.5rem] bg-slate-900/5 p-4 dark:bg-white/5">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Routes with higher risk right now</div>
            <div className="mt-3 space-y-3">
              {disruptedRoutes.map(({ route, alertCount }) => (
                <RouteCard key={`disrupted-${route.id}`} route={route} alertCount={alertCount} emphasis="disrupted" />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

function FollowPanel({ selectedVehicle, followedVehicleId, setFollowedVehicleId }: PanelProps) {
  return (
    <SectionCard title="Follow bus" subtitle="Lock the map onto a moving bus and inspect its next few stops." icon={<Radar className="h-5 w-5" />}>
      {selectedVehicle ? (
        <div className="space-y-4">
          <div className="rounded-[1.5rem] bg-slate-900/5 p-4 dark:bg-white/5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full px-2 py-1 text-xs font-black" style={{ backgroundColor: selectedVehicle.routeColor, color: selectedVehicle.routeTextColor }}>
                    {compactRouteLabel(selectedVehicle.routeShortName, selectedVehicle.headsign)}
                  </span>
                  <span className="text-sm font-semibold">Vehicle {selectedVehicle.label}</span>
                </div>
                <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">{selectedVehicle.headsign}</div>
              </div>
              <button
                onClick={() => setFollowedVehicleId((current) => (current === selectedVehicle.id ? null : selectedVehicle.id))}
                className={clsx('rounded-full px-4 py-2 text-sm font-semibold', followedVehicleId === selectedVehicle.id ? 'bg-accent text-white' : 'bg-pine text-white dark:bg-gold dark:text-slate-950')}
              >
                {followedVehicleId === selectedVehicle.id ? 'Following' : 'Follow'}
              </button>
            </div>
            <div className="mt-4 space-y-2">
              {selectedVehicle.nextStops.map((stop) => (
                <div key={`${selectedVehicle.id}-${stop.id}-${stop.sequence}`} className="flex items-center justify-between rounded-2xl bg-white/80 px-3 py-2 text-sm dark:bg-slate-950/70">
                  <span className="font-medium">{stop.name}</span>
                  <span className="text-xs text-slate-500">{formatTime(stop.arrivalTime)}</span>
                </div>
              ))}
              {!selectedVehicle.nextStops.length ? <div className="text-sm text-slate-500">No upcoming stops available from the current live feed.</div> : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-[1.5rem] border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
          Tap a bus marker on the map to keep it centered and inspect its next stops.
        </div>
      )}
    </SectionCard>
  );
}

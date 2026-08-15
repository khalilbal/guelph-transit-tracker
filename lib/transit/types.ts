export type TransitMeta = {
  configured: boolean;
  missingVariables: string[];
  refreshedAt: string | null;
  staticLoadedAt: string | null;
  stale: boolean;
  ml: {
    historyLoggingEnabled: boolean;
    artifactConfigured: boolean;
    artifactLoaded: boolean;
    modelTarget: string | null;
    trainedAt: string | null;
  };
  warnings: string[];
  errors: string[];
};

export type TransitApiResponse<T> = {
  data: T;
  meta: TransitMeta;
};

export type RouteReliability = {
  averageDelayMinutes: number;
  activeVehicles: number;
  staleVehicles: number;
  status: 'strong' | 'watch' | 'disrupted' | 'scheduled-only';
};

export type TransitRoute = {
  id: string;
  shortName: string;
  longName: string;
  color: string;
  textColor: string;
  type: number;
  sortKey: string;
  shapePaths: Array<Array<{ lat: number; lng: number }>>;
  reliability: RouteReliability;
};

export type TransitStop = {
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  wheelchairBoarding: boolean;
  routeIds: string[];
};

export type NextStop = {
  id: string;
  name: string;
  sequence: number;
  arrivalTime: string | null;
};

export type TransitVehicle = {
  id: string;
  label: string;
  tripId: string | null;
  routeId: string | null;
  routeShortName: string;
  routeColor: string;
  routeTextColor: string;
  headsign: string;
  lat: number;
  lng: number;
  bearing: number | null;
  speedKph: number | null;
  lastUpdated: string | null;
  isStale: boolean;
  status: string;
  currentStopSequence: number | null;
  delaySeconds: number | null;
  nextStopId: string | null;
  nextStopName: string | null;
  nextStops: NextStop[];
};

export type ArrivalConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export type ArrivalRecommendation = 'recommended' | 'consider' | 'wait';

export type TransitArrival = {
  stopId: string;
  tripId: string;
  routeId: string;
  routeShortName: string;
  routeColor: string;
  routeTextColor: string;
  headsign: string;
  directionId: string | null;
  scheduledDeparture: string;
  estimatedDeparture: string;
  etaMinutes: number;
  delaySeconds: number;
  status: 'early' | 'on-time' | 'delayed' | 'scheduled';
  isRealtime: boolean;
  vehicleId: string | null;
  vehicleLabel: string | null;
  stopsAway: number | null;
  destinationReachable: boolean;
  travelTimeToDestinationMinutes: number | null;
  confidenceScore: number;
  confidenceLevel: ArrivalConfidenceLevel;
  recommendation: ArrivalRecommendation;
  reasons: string[];
};

export type TransitAlert = {
  id: string;
  header: string;
  description: string;
  severity: string;
  effect: string;
  routeIds: string[];
  stopIds: string[];
  activePeriods: Array<{
    start: string | null;
    end: string | null;
  }>;
  url: string | null;
};

export type NearbyStop = TransitStop & {
  distanceMeters: number;
  nextArrival: TransitArrival | null;
};

export type NearbyVehicle = TransitVehicle & {
  distanceMeters: number;
};

export type NearbyTransit = {
  stops: NearbyStop[];
  vehicles: NearbyVehicle[];
  bestDeparture: TransitArrival | null;
};

export type ContextualRouteHighlight = {
  routeId: string;
  routeShortName: string;
  routeColor: string;
  routeTextColor: string;
  sourceStopId: string;
  sourceStopName: string;
  targetStopId: string;
  targetStopName: string;
  distanceMeters: number | null;
  nextDepartureEtaMinutes: number | null;
  nextDepartureTime: string | null;
  headsign: string | null;
  reason: 'origin-stop' | 'nearby-stop';
};

export type CommuteOption = {
  routeId: string;
  routeShortName: string;
  routeColor: string;
  routeTextColor: string;
  headsign: string;
  originStopId: string;
  destinationStopId: string;
  departureTime: string;
  etaMinutes: number;
  waitMinutes: number;
  travelTimeMinutes: number | null;
  arrivalTime: string | null;
  delaySeconds: number;
  vehicleLabel: string | null;
  shapePoints: Array<{ lat: number; lng: number }>;
  confidenceScore: number;
  confidenceLevel: ArrivalConfidenceLevel;
  recommendation: ArrivalRecommendation;
  reasons: string[];
};

export type RoutePreview = {
  routeId: string;
  routeShortName: string;
  routeLongName: string;
  routeColor: string;
  routeTextColor: string;
  headsign: string;
  originStopId: string;
  originStopName: string;
  destinationStopId: string;
  destinationStopName: string;
  shapePoints: Array<{ lat: number; lng: number }>;
};

export type StopArrivalsResponse = {
  stop: TransitStop | null;
  arrivals: TransitArrival[];
  bestForDestination: CommuteOption | null;
  suggestedOptions: CommuteOption[];
  routePreviews: RoutePreview[];
};

export type JourneyLeg = {
  tripId: string;
  routeId: string;
  routeShortName: string;
  routeColor: string;
  routeTextColor: string;
  headsign: string;
  fromStopId: string;
  fromStopName: string;
  toStopId: string;
  toStopName: string;
  departureTime: string;
  arrivalTime: string;
  waitMinutes: number;
  rideMinutes: number;
  delaySeconds: number;
  vehicleLabel: string | null;
  confidenceScore: number;
  confidenceLevel: ArrivalConfidenceLevel;
  recommendation: ArrivalRecommendation;
  reasons: string[];
  shapePoints: Array<{ lat: number; lng: number }>;
};

export type JourneyOption = {
  id: string;
  legCount: number;
  departureTime: string;
  arrivalTime: string;
  totalWaitMinutes: number;
  totalRideMinutes: number;
  totalDurationMinutes: number;
  transferStopId: string | null;
  transferStopName: string | null;
  confidenceScore: number;
  confidenceLevel: ArrivalConfidenceLevel;
  recommendation: ArrivalRecommendation;
  reasons: string[];
  legs: JourneyLeg[];
};

export type JourneyPlanResponse = {
  originStop: TransitStop | null;
  destinationStop: TransitStop | null;
  bestOption: JourneyOption | null;
  options: JourneyOption[];
  routePreviews: RoutePreview[];
};

export type NearbyQuery = {
  lat: number;
  lng: number;
  radiusMeters?: number;
};

export type StopSearchResponse = {
  stops: TransitStop[];
};

export type AddressResolvedStop = TransitStop & {
  distanceMeters: number;
  walkingMinutes: number;
  routeCount: number;
};

export type AddressLookupResult = {
  id: string;
  displayName: string;
  lat: number;
  lng: number;
  nearestStops: AddressResolvedStop[];
};

export type AddressLookupResponse = {
  results: AddressLookupResult[];
};

export type VehicleResponse = {
  vehicles: TransitVehicle[];
};

export type RouteResponse = {
  routes: TransitRoute[];
};

export type AlertResponse = {
  alerts: TransitAlert[];
};

export type NearbyResponse = {
  nearby: NearbyTransit;
};

export type JourneyResponse = {
  journey: JourneyPlanResponse;
};

export type CsvRow = Record<string, string>;

export type GtfsRoute = {
  routeId: string;
  routeShortName: string;
  routeLongName: string;
  routeColor: string;
  routeTextColor: string;
  routeType: number;
};

export type GtfsStop = {
  stopId: string;
  stopCode: string;
  stopName: string;
  stopLat: number;
  stopLng: number;
  wheelchairBoarding: boolean;
};

export type GtfsTrip = {
  tripId: string;
  routeId: string;
  serviceId: string;
  tripHeadsign: string;
  directionId: string | null;
  shapeId: string | null;
};

export type GtfsStopTime = {
  tripId: string;
  stopId: string;
  arrivalSeconds: number;
  departureSeconds: number;
  stopSequence: number;
};

export type GtfsShapePoint = {
  shapeId: string;
  lat: number;
  lng: number;
  sequence: number;
};

export type CalendarEntry = {
  serviceId: string;
  activeWeekdays: Set<number>;
  startDate: string;
  endDate: string;
};

export type CalendarDateException = {
  serviceId: string;
  date: string;
  exceptionType: 1 | 2;
};

export type StaticDataset = {
  routesById: Map<string, GtfsRoute>;
  stopsById: Map<string, GtfsStop>;
  tripsById: Map<string, GtfsTrip>;
  stopTimesByStopId: Map<string, GtfsStopTime[]>;
  stopTimesByTripId: Map<string, GtfsStopTime[]>;
  stopRouteIds: Map<string, Set<string>>;
  shapesById: Map<string, GtfsShapePoint[]>;
  calendars: CalendarEntry[];
  calendarExceptions: CalendarDateException[];
};

export type RealtimeStopTimeUpdate = {
  stopId: string | null;
  stopSequence: number | null;
  arrivalTimeMs: number | null;
  departureTimeMs: number | null;
  delaySeconds: number | null;
};

export type RealtimeTripUpdate = {
  tripId: string;
  vehicleId: string | null;
  vehicleLabel: string | null;
  timestampMs: number | null;
  delaySeconds: number | null;
  stopTimeUpdates: RealtimeStopTimeUpdate[];
};

export type RealtimeVehiclePosition = {
  id: string;
  label: string;
  tripId: string | null;
  routeId: string | null;
  lat: number;
  lng: number;
  bearing: number | null;
  speedKph: number | null;
  timestampMs: number | null;
  status: string;
  currentStopSequence: number | null;
};

export type RealtimeAlert = {
  id: string;
  header: string;
  description: string;
  severity: string;
  effect: string;
  routeIds: string[];
  stopIds: string[];
  activePeriods: Array<{ start: string | null; end: string | null }>;
  url: string | null;
};

export type RealtimeDataset = {
  vehicles: RealtimeVehiclePosition[];
  tripUpdates: Map<string, RealtimeTripUpdate>;
  alerts: RealtimeAlert[];
  feedTimestampMs: number | null;
};

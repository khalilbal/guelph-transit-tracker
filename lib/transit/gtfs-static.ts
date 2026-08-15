import AdmZip from 'adm-zip';

import { parseCsvObjects } from '@/lib/transit/csv';
import { parseGtfsTimeToSeconds } from '@/lib/transit/time';
import {
  CalendarDateException,
  CalendarEntry,
  CsvRow,
  GtfsRoute,
  GtfsShapePoint,
  GtfsStop,
  GtfsStopTime,
  GtfsTrip,
  StaticDataset,
} from '@/lib/transit/types';

function textFromEntry(zip: AdmZip, fileName: string): string {
  const entry = zip.getEntry(fileName);
  if (!entry) {
    return '';
  }
  return zip.readAsText(entry, 'utf8');
}

function parseRoute(row: CsvRow): GtfsRoute | null {
  if (!row.route_id) {
    return null;
  }

  return {
    routeId: row.route_id,
    routeShortName: row.route_short_name || row.route_id,
    routeLongName: row.route_long_name || row.route_desc || row.route_short_name || row.route_id,
    routeColor: row.route_color || '0A9396',
    routeTextColor: row.route_text_color || 'FFFFFF',
    routeType: Number(row.route_type || '3'),
  };
}

function parseStop(row: CsvRow): GtfsStop | null {
  if (!row.stop_id || !row.stop_lat || !row.stop_lon) {
    return null;
  }

  return {
    stopId: row.stop_id,
    stopCode: row.stop_code || row.stop_id,
    stopName: row.stop_name || row.stop_id,
    stopLat: Number(row.stop_lat),
    stopLng: Number(row.stop_lon),
    wheelchairBoarding: row.wheelchair_boarding === '1',
  };
}

function parseTrip(row: CsvRow): GtfsTrip | null {
  if (!row.trip_id || !row.route_id || !row.service_id) {
    return null;
  }

  return {
    tripId: row.trip_id,
    routeId: row.route_id,
    serviceId: row.service_id,
    tripHeadsign: row.trip_headsign || '',
    directionId: row.direction_id || null,
    shapeId: row.shape_id || null,
  };
}

function parseStopTime(row: CsvRow): GtfsStopTime | null {
  if (!row.trip_id || !row.stop_id || !row.stop_sequence) {
    return null;
  }

  const arrival = row.arrival_time ? parseGtfsTimeToSeconds(row.arrival_time) : 0;
  const departure = row.departure_time ? parseGtfsTimeToSeconds(row.departure_time) : arrival;

  return {
    tripId: row.trip_id,
    stopId: row.stop_id,
    arrivalSeconds: arrival,
    departureSeconds: departure,
    stopSequence: Number(row.stop_sequence),
  };
}

function parseShapePoint(row: CsvRow): GtfsShapePoint | null {
  if (!row.shape_id || !row.shape_pt_lat || !row.shape_pt_lon || !row.shape_pt_sequence) {
    return null;
  }

  return {
    shapeId: row.shape_id,
    lat: Number(row.shape_pt_lat),
    lng: Number(row.shape_pt_lon),
    sequence: Number(row.shape_pt_sequence),
  };
}

function parseCalendar(row: CsvRow): CalendarEntry | null {
  if (!row.service_id || !row.start_date || !row.end_date) {
    return null;
  }

  const activeWeekdays = new Set<number>();
  if (row.sunday === '1') activeWeekdays.add(0);
  if (row.monday === '1') activeWeekdays.add(1);
  if (row.tuesday === '1') activeWeekdays.add(2);
  if (row.wednesday === '1') activeWeekdays.add(3);
  if (row.thursday === '1') activeWeekdays.add(4);
  if (row.friday === '1') activeWeekdays.add(5);
  if (row.saturday === '1') activeWeekdays.add(6);

  return {
    serviceId: row.service_id,
    activeWeekdays,
    startDate: row.start_date,
    endDate: row.end_date,
  };
}

function parseCalendarException(row: CsvRow): CalendarDateException | null {
  if (!row.service_id || !row.date || !row.exception_type) {
    return null;
  }

  const exceptionType = Number(row.exception_type) as 1 | 2;
  if (exceptionType !== 1 && exceptionType !== 2) {
    return null;
  }

  return {
    serviceId: row.service_id,
    date: row.date,
    exceptionType,
  };
}

export async function loadStaticGtfs(url: string): Promise<StaticDataset> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Static GTFS request failed with ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const zip = new AdmZip(Buffer.from(arrayBuffer));

  const routesRows = parseCsvObjects(textFromEntry(zip, 'routes.txt'));
  const stopsRows = parseCsvObjects(textFromEntry(zip, 'stops.txt'));
  const tripsRows = parseCsvObjects(textFromEntry(zip, 'trips.txt'));
  const stopTimesRows = parseCsvObjects(textFromEntry(zip, 'stop_times.txt'));
  const shapesRows = parseCsvObjects(textFromEntry(zip, 'shapes.txt'));
  const calendarRows = parseCsvObjects(textFromEntry(zip, 'calendar.txt'));
  const calendarDateRows = parseCsvObjects(textFromEntry(zip, 'calendar_dates.txt'));

  const routesById = new Map<string, GtfsRoute>();
  const stopsById = new Map<string, GtfsStop>();
  const tripsById = new Map<string, GtfsTrip>();
  const stopTimesByStopId = new Map<string, GtfsStopTime[]>();
  const stopTimesByTripId = new Map<string, GtfsStopTime[]>();
  const stopRouteIds = new Map<string, Set<string>>();
  const shapesById = new Map<string, GtfsShapePoint[]>();

  routesRows.map(parseRoute).forEach((route) => {
    if (route) {
      routesById.set(route.routeId, route);
    }
  });

  stopsRows.map(parseStop).forEach((stop) => {
    if (stop) {
      stopsById.set(stop.stopId, stop);
    }
  });

  tripsRows.map(parseTrip).forEach((trip) => {
    if (trip) {
      tripsById.set(trip.tripId, trip);
    }
  });

  stopTimesRows.map(parseStopTime).forEach((stopTime) => {
    if (!stopTime) {
      return;
    }

    const stopEntries = stopTimesByStopId.get(stopTime.stopId) ?? [];
    stopEntries.push(stopTime);
    stopTimesByStopId.set(stopTime.stopId, stopEntries);

    const tripEntries = stopTimesByTripId.get(stopTime.tripId) ?? [];
    tripEntries.push(stopTime);
    stopTimesByTripId.set(stopTime.tripId, tripEntries);

    const trip = tripsById.get(stopTime.tripId);
    if (trip) {
      const routeIds = stopRouteIds.get(stopTime.stopId) ?? new Set<string>();
      routeIds.add(trip.routeId);
      stopRouteIds.set(stopTime.stopId, routeIds);
    }
  });

  stopTimesByStopId.forEach((value) => value.sort((a, b) => a.departureSeconds - b.departureSeconds));
  stopTimesByTripId.forEach((value) => value.sort((a, b) => a.stopSequence - b.stopSequence));

  shapesRows.map(parseShapePoint).forEach((shapePoint) => {
    if (!shapePoint) {
      return;
    }

    const entries = shapesById.get(shapePoint.shapeId) ?? [];
    entries.push(shapePoint);
    shapesById.set(shapePoint.shapeId, entries);
  });
  shapesById.forEach((value) => value.sort((a, b) => a.sequence - b.sequence));

  const calendars = calendarRows.map(parseCalendar).filter((entry): entry is CalendarEntry => Boolean(entry));
  const calendarExceptions = calendarDateRows
    .map(parseCalendarException)
    .filter((entry): entry is CalendarDateException => Boolean(entry));

  return {
    routesById,
    stopsById,
    tripsById,
    stopTimesByStopId,
    stopTimesByTripId,
    stopRouteIds,
    shapesById,
    calendars,
    calendarExceptions,
  };
}

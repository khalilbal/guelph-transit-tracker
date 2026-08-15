type PhotonFeature = {
  geometry?: {
    coordinates?: [number, number];
  };
  properties?: {
    osm_id?: number | string;
    name?: string;
    street?: string;
    housenumber?: string;
    city?: string;
    district?: string;
    state?: string;
    country?: string;
  };
};

type PhotonResponse = {
  features?: PhotonFeature[];
};

type ArcgisFeature = {
  attributes?: {
    OBJECTID?: number;
    name?: string;
    address?: string;
    streetname?: string;
    stname?: string;
    stsuf?: string;
    unit_no?: string;
    streetno?: string | number;
    fullname?: string;
    postcomm?: string;
    lat?: number;
    long?: number;
  };
  geometry?: {
    x?: number;
    y?: number;
  };
};

type ArcgisResponse = {
  features?: ArcgisFeature[];
};

type GeocoderCaResponse = {
  standard?: {
    staddress?: string;
    stnumber?: string;
    city?: string;
    prov?: string;
    confidence?: string;
  };
  postal?: string;
  latt?: string;
  longt?: string;
  error?: string;
};

type GeocodeResult = {
  id: string;
  displayName: string;
  lat: number;
  lng: number;
};

type CacheEntry = {
  expiresAt: number;
  value: GeocodeResult[];
};

type ParsedAddressQuery = {
  normalized: string;
  compact: string;
  streetNumber: string | null;
  streetText: string;
};

const GUELPH_ADDRESS_LAYER_URL =
  process.env.GUELPH_ADDRESS_SEARCH_URL ??
  'https://services1.arcgis.com/B6yKvIZqzuOr0jBR/ArcGIS/rest/services/Guelph_Addresses_New/FeatureServer/28';
const CANADA_ADDRESS_FALLBACK_URL = process.env.CA_ADDRESS_FALLBACK_URL ?? 'https://geocode.ca';
const PHOTON_URL = process.env.GEOCODER_AUTOCOMPLETE_URL ?? 'https://photon.komoot.io/api';
const CACHE_TTL_MS = 1000 * 60 * 30;
const STREET_SUFFIXES = [
  'lane',
  'ln',
  'street',
  'st',
  'road',
  'rd',
  'avenue',
  'ave',
  'drive',
  'dr',
  'crescent',
  'cres',
  'court',
  'ct',
  'place',
  'pl',
  'boulevard',
  'blvd',
  'parkway',
  'pkwy',
  'way',
  'terrace',
  'terr',
  'trail',
  'circle',
  'cir',
];
const ADDRESS_NOISE = new Set([
  'guelph',
  'ontario',
  'canada',
  'on',
  'ca',
]);
const GUELPH_CENTER = {
  lat: 43.5448,
  lng: -80.2482,
};
const GUELPH_BOUNDS = {
  west: -80.42,
  south: 43.45,
  east: -80.1,
  north: 43.65,
};

const cache = new Map<string, CacheEntry>();

function normalizeQuery(query: string) {
  return query
    .trim()
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ');
}

function withGuelphContext(query: string) {
  if (/guelph/i.test(query)) {
    return query.trim();
  }
  return `${query.trim()}, Guelph, Ontario, Canada`;
}

function parseAddressQuery(query: string): ParsedAddressQuery {
  const normalized = normalizeQuery(query);
  const tokens = normalized.split(' ').filter(Boolean).filter((token) => !ADDRESS_NOISE.has(token));
  const streetNumber = tokens[0] && /^\d+[a-z]?$/.test(tokens[0]) ? tokens[0] : null;
  const streetTokens = streetNumber ? tokens.slice(1) : tokens;

  return {
    normalized,
    compact: [streetNumber, ...streetTokens].filter(Boolean).join(' ').trim(),
    streetNumber,
    streetText: streetTokens.join(' ').trim(),
  };
}

function buildQueryVariants(query: string) {
  const parsed = parseAddressQuery(query);
  const variants = new Set<string>();
  const tokens = parsed.streetText.split(' ').filter(Boolean);
  const lastToken = tokens[tokens.length - 1] ?? '';
  const hasSuffix = STREET_SUFFIXES.includes(lastToken);

  variants.add(withGuelphContext(query.trim()));
  variants.add(withGuelphContext(parsed.compact || query.trim()));

  if (parsed.streetNumber && !hasSuffix && parsed.streetText) {
    ['lane', 'street', 'road', 'avenue', 'drive', 'crescent', 'court', 'place', 'boulevard', 'way'].forEach((suffix) => {
      variants.add(withGuelphContext(`${parsed.streetNumber} ${parsed.streetText} ${suffix}`));
    });
  }

  return Array.from(variants).slice(0, 12);
}

function insideGuelph(lat: number, lng: number) {
  return lat >= GUELPH_BOUNDS.south && lat <= GUELPH_BOUNDS.north && lng >= GUELPH_BOUNDS.west && lng <= GUELPH_BOUNDS.east;
}

function escapeSql(value: string) {
  return value.replace(/'/g, "''");
}

function compactDisplayName(feature: PhotonFeature) {
  const props = feature.properties ?? {};
  const line1 = [props.housenumber, props.street || props.name].filter(Boolean).join(' ').trim();
  const line2 = [props.city || props.district, props.state || 'Ontario'].filter(Boolean).join(', ');
  return [line1, line2, props.country || 'Canada'].filter(Boolean).join(', ');
}

function officialDisplayName(feature: ArcgisFeature) {
  const attributes = feature.attributes ?? {};
  const line1 =
    attributes.name ||
    attributes.address ||
    [attributes.unit_no, attributes.streetno, attributes.streetname || attributes.fullname || [attributes.stname, attributes.stsuf].filter(Boolean).join(' ')].filter(Boolean).join(' ').trim();

  return [line1, attributes.postcomm || 'Guelph', 'Ontario', 'Canada'].filter(Boolean).join(', ');
}

function queryScore(result: GeocodeResult, query: string) {
  const parsed = parseAddressQuery(query);
  const label = normalizeQuery(result.displayName);
  let score = 0;

  if (label.startsWith(parsed.compact)) {
    score += 45;
  }

  parsed.compact.split(' ').forEach((token) => {
    if (label.includes(token)) {
      score += token.length >= 4 ? 12 : 5;
    }
  });

  if (parsed.streetNumber && label.startsWith(parsed.streetNumber)) {
    score += 30;
  }

  if (label.includes('guelph')) {
    score += 10;
  }

  return score;
}

function buildOfficialWhere(query: string) {
  const parsed = parseAddressQuery(query);
  const clauses = new Set<string>();
  const compact = escapeSql(parsed.compact.toUpperCase());
  const streetText = escapeSql(parsed.streetText.toUpperCase());

  if (parsed.streetNumber && streetText) {
    clauses.add(`(streetno LIKE '${escapeSql(parsed.streetNumber.toUpperCase())}%' AND (UPPER(fullname) LIKE '%${streetText}%' OR UPPER(name) LIKE '%${streetText}%' OR UPPER(address) LIKE '%${streetText}%' OR UPPER(streetname) LIKE '%${streetText}%' OR UPPER(stname) LIKE '%${streetText}%'))`);
    clauses.add(`UPPER(name) LIKE '%${compact}%'`);
    clauses.add(`UPPER(address) LIKE '%${compact}%'`);
  } else if (streetText) {
    clauses.add(`UPPER(fullname) LIKE '%${streetText}%'`);
    clauses.add(`UPPER(name) LIKE '%${streetText}%'`);
    clauses.add(`UPPER(address) LIKE '%${streetText}%'`);
    clauses.add(`UPPER(streetname) LIKE '%${streetText}%'`);
    clauses.add(`UPPER(stname) LIKE '%${streetText}%'`);
  } else if (compact) {
    clauses.add(`UPPER(name) LIKE '%${compact}%'`);
    clauses.add(`UPPER(address) LIKE '%${compact}%'`);
  }

  if (!clauses.size) {
    return '1=0';
  }

  return Array.from(clauses).join(' OR ');
}

async function fetchOfficialGuelphAddressResults(query: string): Promise<GeocodeResult[]> {
  const where = buildOfficialWhere(query);
  if (where === '1=0') {
    return [];
  }

  const params = new URLSearchParams({
    where,
    outFields: 'OBJECTID,name,address,streetname,stname,stsuf,unit_no,streetno,fullname,postcomm,lat,long',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '8',
    f: 'json',
  });

  const response = await fetch(`${GUELPH_ADDRESS_LAYER_URL}/query?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GuelphTransitPulse/1.0',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Official address lookup failed with ${response.status}`);
  }

  const payload = (await response.json()) as ArcgisResponse;
  const unique = new Map<string, GeocodeResult>();

  (payload.features ?? []).forEach((feature) => {
    const attributes = feature.attributes ?? {};
    const latValue = typeof attributes.lat === 'number' ? attributes.lat : feature.geometry?.y;
    const lngValue = typeof attributes.long === 'number' ? attributes.long : feature.geometry?.x;
    if (typeof latValue !== 'number' || typeof lngValue !== 'number' || !insideGuelph(latValue, lngValue)) {
      return;
    }
    const lat = latValue;
    const lng = lngValue;

    const id = String(attributes.OBJECTID ?? `${lat}:${lng}`);
    if (unique.has(id)) {
      return;
    }

    unique.set(id, {
      id,
      displayName: officialDisplayName(feature),
      lat,
      lng,
    });
  });

  return Array.from(unique.values());
}

async function fetchPhotonResults(query: string): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({
    q: query,
    limit: '6',
    lat: String(GUELPH_CENTER.lat),
    lon: String(GUELPH_CENTER.lng),
    bbox: `${GUELPH_BOUNDS.west},${GUELPH_BOUNDS.south},${GUELPH_BOUNDS.east},${GUELPH_BOUNDS.north}`,
  });

  const response = await fetch(`${PHOTON_URL}?${params.toString()}`, {
    headers: {
      'Accept-Language': 'en-CA,en;q=0.9',
      'User-Agent': 'GuelphTransitPulse/1.0',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Address lookup failed with ${response.status}`);
  }

  const payload = (await response.json()) as PhotonResponse;
  const unique = new Map<string, GeocodeResult>();

  (payload.features ?? []).forEach((feature) => {
    const coordinates = feature.geometry?.coordinates;
    if (!coordinates || coordinates.length < 2) {
      return;
    }

    const [lng, lat] = coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !insideGuelph(lat, lng)) {
      return;
    }

    const props = feature.properties ?? {};
    const id = String(props.osm_id ?? `${lat}:${lng}`);
    if (unique.has(id)) {
      return;
    }

    unique.set(id, {
      id,
      displayName: compactDisplayName(feature),
      lat,
      lng,
    });
  });

  return Array.from(unique.values());
}

async function fetchCanadianFallbackResults(query: string): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({
    locate: withGuelphContext(query),
    json: '1',
  });

  const response = await fetch(`${CANADA_ADDRESS_FALLBACK_URL}/?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GuelphTransitPulse/1.0',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Canadian address lookup failed with ${response.status}`);
  }

  const payload = (await response.json()) as GeocoderCaResponse;
  const lat = Number(payload.latt);
  const lng = Number(payload.longt);
  const confidence = Number(payload.standard?.confidence ?? '0');

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !insideGuelph(lat, lng) || confidence < 0.5) {
    return [];
  }

  const line1 = [payload.standard?.stnumber, payload.standard?.staddress].filter(Boolean).join(' ').trim();
  return [
    {
      id: `geocode-ca:${line1}:${lat}:${lng}`,
      displayName: [line1, payload.standard?.city || 'Guelph', payload.standard?.prov || 'Ontario', 'Canada'].filter(Boolean).join(', '),
      lat,
      lng,
    },
  ];
}

export async function lookupGuelphAddresses(query: string): Promise<GeocodeResult[]> {
  const normalized = normalizeQuery(query);
  if (normalized.length < 3) {
    return [];
  }

  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const unique = new Map<string, GeocodeResult>();

  try {
    const officialResults = await fetchOfficialGuelphAddressResults(query);
    officialResults.forEach((result) => {
      if (!unique.has(result.id)) {
        unique.set(result.id, result);
      }
    });
  } catch {
    // Fall back to the generic geocoder if the official layer is temporarily unavailable.
  }

  if (unique.size < 5) {
    try {
      const canadaFallback = await fetchCanadianFallbackResults(query);
      canadaFallback.forEach((result) => {
        if (!unique.has(result.id)) {
          unique.set(result.id, result);
        }
      });
    } catch {
      // Ignore fallback-provider failures and continue to the generic provider.
    }
  }

  if (unique.size < 5) {
    const variants = buildQueryVariants(query);
    for (const variant of variants) {
      try {
        const results = await fetchPhotonResults(variant);
        results.forEach((result) => {
          if (!unique.has(result.id)) {
            unique.set(result.id, result);
          }
        });
      } catch {
        // Ignore transient provider failures while trying the remaining fallbacks.
      }

      if (unique.size >= 5) {
        break;
      }
    }
  }

  const value = Array.from(unique.values())
    .sort((left, right) => queryScore(right, query) - queryScore(left, query))
    .slice(0, 5);

  cache.set(normalized, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  });

  return value;
}

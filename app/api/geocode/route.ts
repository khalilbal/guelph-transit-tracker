import { NextRequest, NextResponse } from 'next/server';

import { lookupGuelphAddresses } from '@/lib/transit/geocode';
import { getTransitService } from '@/lib/transit/service';
import { AddressLookupResponse } from '@/lib/transit/types';
import { jsonError } from '@/lib/utils/api';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q') ?? '';
  if (query.trim().length < 3) {
    return jsonError('Query parameter q must be at least 3 characters.', 400);
  }

  try {
    const matches = await lookupGuelphAddresses(query);
    const results = await Promise.all(
      matches.map(async (match) => ({
        ...match,
        nearestStops: await getTransitService().getNearestStops(match.lat, match.lng, 4, 3000),
      })),
    );

    return NextResponse.json({
      results: results.filter((result) => result.nearestStops.length > 0),
    } satisfies AddressLookupResponse);
  } catch (error) {
    return jsonError((error as Error).message || 'Address lookup failed.');
  }
}

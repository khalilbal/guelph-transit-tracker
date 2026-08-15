import { NextRequest, NextResponse } from 'next/server';

import { getTransitService } from '@/lib/transit/service';
import { jsonError } from '@/lib/utils/api';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const lat = Number(request.nextUrl.searchParams.get('lat'));
  const lng = Number(request.nextUrl.searchParams.get('lng'));
  const radiusMeters = Number(request.nextUrl.searchParams.get('radiusMeters') ?? '900');

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return jsonError('Query parameters lat and lng are required.', 400);
  }

  const data = await getTransitService().getNearby(lat, lng, radiusMeters);
  return NextResponse.json(data);
}

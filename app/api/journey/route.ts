import { NextRequest, NextResponse } from 'next/server';

import { getTransitService } from '@/lib/transit/service';
import { jsonError } from '@/lib/utils/api';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const originStopId = request.nextUrl.searchParams.get('originStopId');
  const destinationStopId = request.nextUrl.searchParams.get('destinationStopId');

  if (!originStopId || !destinationStopId) {
    return jsonError('Query parameters originStopId and destinationStopId are required.', 400);
  }

  const data = await getTransitService().getJourney(originStopId, destinationStopId);
  return NextResponse.json(data);
}

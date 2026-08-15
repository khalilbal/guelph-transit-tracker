import { NextRequest, NextResponse } from 'next/server';

import { getTransitService } from '@/lib/transit/service';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const destinationStopId = request.nextUrl.searchParams.get('destinationStopId') ?? undefined;
  const data = await getTransitService().getStopArrivals(id, destinationStopId);
  return NextResponse.json(data);
}

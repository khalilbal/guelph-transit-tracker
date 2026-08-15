import { NextRequest, NextResponse } from 'next/server';

import { getTransitService } from '@/lib/transit/service';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q') ?? '';
  const data = await getTransitService().searchStops(query);
  return NextResponse.json(data);
}

import { NextResponse } from 'next/server';

import { getTransitService } from '@/lib/transit/service';

export const runtime = 'nodejs';

export async function GET() {
  const data = await getTransitService().getVehicles();
  return NextResponse.json(data);
}

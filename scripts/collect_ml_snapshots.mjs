#!/usr/bin/env node

const baseUrl = process.env.TRANSIT_APP_BASE_URL ?? 'http://127.0.0.1:3000';
const stopIds = (process.env.TRANSIT_COLLECT_STOP_IDS ?? '1615,1636,5965,204,121,5910')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const intervalMs = Number(process.env.TRANSIT_COLLECT_INTERVAL_MS ?? '5000');
const durationMs = Number(process.env.TRANSIT_COLLECT_DURATION_MS ?? String(10 * 60 * 1000));

if (!stopIds.length) {
  console.error('Set TRANSIT_COLLECT_STOP_IDS to one or more stop ids.');
  process.exit(1);
}

const startedAt = Date.now();

async function pollOnce() {
  await Promise.all(
    stopIds.map(async (stopId) => {
      const response = await fetch(`${baseUrl}/api/stops/${stopId}/arrivals`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Stop ${stopId} request failed with ${response.status}`);
      }
      const payload = await response.json();
      const count = payload?.data?.arrivals?.length ?? 0;
      console.log(`[${new Date().toISOString()}] stop ${stopId}: ${count} arrivals`);
    }),
  );
}

async function main() {
  console.log(`Collecting ML snapshots from ${baseUrl} for ${Math.round(durationMs / 1000)}s`);
  while (Date.now() - startedAt < durationMs) {
    try {
      await pollOnce();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.log('Snapshot collection finished.');
}

void main();

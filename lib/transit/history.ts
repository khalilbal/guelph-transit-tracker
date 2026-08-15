import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

import { getTransitConfig } from '@/lib/transit/config';
import { ArrivalMlFeatures } from '@/lib/transit/ml';
import { TransitArrival } from '@/lib/transit/types';

type ArrivalSnapshotLogRow = {
  observedAt: string;
  stopId: string;
  routeId: string;
  tripId: string;
  vehicleId: string | null;
  scheduledDeparture: string;
  estimatedDeparture: string;
  etaMinutes: number;
  delaySeconds: number;
  confidenceScore: number;
  confidenceLevel: TransitArrival['confidenceLevel'];
  recommendation: TransitArrival['recommendation'];
  features: ArrivalMlFeatures;
};

let ensuredDir: string | null = null;

async function ensureLogDir(logDir: string) {
  if (ensuredDir === logDir) {
    return;
  }

  await mkdir(logDir, { recursive: true });
  ensuredDir = logDir;
}

export function logArrivalSnapshots(rows: ArrivalSnapshotLogRow[]) {
  const config = getTransitConfig();
  if (!config.historyLoggingEnabled || rows.length === 0) {
    return;
  }

  const logDir = path.isAbsolute(config.historyLogDir)
    ? config.historyLogDir
    : path.join(process.cwd(), config.historyLogDir);
  const filePath = path.join(logDir, 'arrival_snapshots.ndjson');
  const payload = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

  void ensureLogDir(logDir)
    .then(() => appendFile(filePath, payload, 'utf8'))
    .catch(() => {
      // Logging must never break the live app.
    });
}

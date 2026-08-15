#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cwd = process.cwd();
const venvPython = path.join(cwd, '.venv', 'bin', 'python');
const pythonBin = process.env.TRANSIT_ML_PYTHON_BIN || (existsSync(venvPython) ? venvPython : 'python3');
const scriptPath = path.join(cwd, 'ml', 'train_arrival_model.py');
const artifactsDir = path.join(cwd, 'ml', 'artifacts');
const finalArtifactPath = path.join(artifactsDir, 'arrival_reliability_model.json');
const finalMetricsPath = path.join(artifactsDir, 'arrival_reliability_metrics.json');
const candidateArtifactPath = path.join(artifactsDir, 'arrival_reliability_model.candidate.json');
const candidateMetricsPath = path.join(artifactsDir, 'arrival_reliability_metrics.candidate.json');
const trainingCsvPath = path.join(artifactsDir, 'arrival_training_frame.csv');
const allowedRegression = Number(process.env.TRANSIT_ML_MAX_ROC_REGRESSION ?? '0.02');

mkdirSync(artifactsDir, { recursive: true });

const args = [
  scriptPath,
  '--artifact',
  candidateArtifactPath,
  '--metrics-json',
  candidateMetricsPath,
  '--training-csv',
  trainingCsvPath,
  ...process.argv.slice(2),
];
const result = spawnSync(pythonBin, args, {
  cwd,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

const candidateMetrics = JSON.parse(readFileSync(candidateMetricsPath, 'utf8'));
const existingMetrics = existsSync(finalMetricsPath)
  ? JSON.parse(readFileSync(finalMetricsPath, 'utf8'))
  : null;

if (
  existingMetrics &&
  typeof existingMetrics.roc_auc === 'number' &&
  typeof candidateMetrics.roc_auc === 'number' &&
  candidateMetrics.roc_auc + allowedRegression < existingMetrics.roc_auc
) {
  console.error(
    `Candidate model rejected: ROC AUC ${candidateMetrics.roc_auc.toFixed(4)} is worse than current ${existingMetrics.roc_auc.toFixed(4)} beyond allowed regression ${allowedRegression.toFixed(4)}.`,
  );
  process.exit(1);
}

if (existsSync(finalArtifactPath)) {
  copyFileSync(finalArtifactPath, `${finalArtifactPath}.bak`);
}
if (existsSync(finalMetricsPath)) {
  copyFileSync(finalMetricsPath, `${finalMetricsPath}.bak`);
}

renameSync(candidateArtifactPath, finalArtifactPath);
renameSync(candidateMetricsPath, finalMetricsPath);

console.log(`Promoted model artifact to ${finalArtifactPath}`);
console.log(`Promoted metrics to ${finalMetricsPath}`);

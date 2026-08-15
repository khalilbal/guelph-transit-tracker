# Transit Reliability ML

This folder adds a real offline ML path to `Guelph Transit Pulse`.

What it is:
- the app logs live arrival snapshots from official GTFS + GTFS-Realtime feeds
- Python uses `pandas` to turn those snapshots into a training frame
- `scikit-learn` trains a logistic regression model that predicts whether the current ETA is likely to stay within 2 minutes of the realized departure
- the Next.js backend can optionally load that artifact and blend it into the existing rule-based reliability score

What it is not:
- it does not replace the GTFS-Realtime ETA feed
- it predicts the *trustworthiness* of the current ETA and helps answer "take this bus or wait?"

## Data source

The model uses only free/open data already used by the app:
- official City of Guelph GTFS static feed
- official City of Guelph GTFS-Realtime feeds

Historical data is built by logging snapshots over time. There is no need for a paid or proprietary dataset.

## Enable logging

Add to `.env.local`:

```env
TRANSIT_HISTORY_LOGGING=true
TRANSIT_HISTORY_LOG_DIR=data/ml
TRANSIT_ML_ARTIFACT_PATH=ml/artifacts/arrival_reliability_model.json
```

Then run the app normally and use it for a while. The backend will append rows to:

```text
data/ml/arrival_snapshots.ndjson
```

## Train

Create a Python virtual environment and install dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r ml/requirements.txt
```

Train or retrain the model:

```bash
npm run retrain:ml
```

Or collect starter snapshots from a running local app first:

```bash
npm run collect:ml
```

Outputs:
- `ml/artifacts/arrival_reliability_model.json`
- `ml/artifacts/arrival_training_frame.csv`
- `ml/artifacts/arrival_reliability_metrics.json`

## Healthiest training workflow

Do this:
- keep `TRANSIT_HISTORY_LOGGING=true` while the app runs
- collect data continuously from real official feeds
- retrain on a schedule, not on every request
- validate on the newest time window before promoting the model

Do not do this:
- online self-training inside the live request path
- random train/test splits for time-series-like transit data
- promoting a new artifact without checking validation metrics

The trainer now uses a time-based holdout:
- older rows train the model
- the newest rows are reserved for validation

Recommended cadence:
1. log data every day the app is running
2. retrain nightly or every few days
3. inspect `ml/artifacts/arrival_reliability_metrics.json`
4. keep the previous artifact if the newer one regresses

`npm run retrain:ml` already helps with this:
- trains to candidate artifact files first
- compares candidate ROC AUC against the current saved metrics
- only promotes the candidate if it does not regress beyond the allowed tolerance

## How the label is built

For each `(tripId, stopId, scheduledDeparture)` group:
- every live snapshot is logged
- the latest observed `estimatedDeparture` becomes the realized proxy departure
- earlier snapshots are labeled as reliable if their ETA stayed within 2 minutes of that realized departure

This is approximate, but it is still materially different from the raw feed ETA:
- feed ETA = current provider estimate
- ML reliability = probability that the current estimate will hold up

## Good next steps

1. Collect at least several days of snapshots.
2. Add time-of-day and weekday features.
3. Add transfer-success and wait-vs-go models.
4. Add route-specific calibration if enough data exists per route.

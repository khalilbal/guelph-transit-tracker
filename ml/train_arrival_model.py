#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, roc_auc_score


FEATURE_COLUMNS = [
    "etaMinutes",
    "absDelayMinutes",
    "isRealtime",
    "hasVehicle",
    "vehicleStale",
    "movingNormally",
    "feedAgeSeconds",
    "distanceToStopMeters",
    "stopsAway",
    "vehicleSpeedKph",
    "routeActiveVehicles",
    "routeStaleRatio",
    "routeAverageDelayMinutes",
    "alertCount",
    "stopAlertCount",
    "routeAlertCount",
]


def load_snapshots(path: Path) -> pd.DataFrame:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            payload = json.loads(line)
            features = payload.pop("features", {})
            rows.append({**payload, **features})

    frame = pd.DataFrame(rows)
    if frame.empty:
        raise ValueError("No arrival snapshots found.")

    frame["observedAt"] = pd.to_datetime(frame["observedAt"], utc=True)
    frame["scheduledDeparture"] = pd.to_datetime(frame["scheduledDeparture"], utc=True)
    frame["estimatedDeparture"] = pd.to_datetime(frame["estimatedDeparture"], utc=True)
    return frame.sort_values(["tripId", "stopId", "scheduledDeparture", "observedAt"]).reset_index(drop=True)


def build_training_frame(frame: pd.DataFrame) -> pd.DataFrame:
    group_key = ["tripId", "stopId", "scheduledDeparture"]
    realized_departure = (
        frame.groupby(group_key)["estimatedDeparture"]
        .last()
        .rename("realizedDeparture")
        .reset_index()
    )

    merged = frame.merge(realized_departure, on=group_key, how="left")
    merged["predictionErrorSeconds"] = (
        merged["realizedDeparture"] - merged["estimatedDeparture"]
    ).dt.total_seconds().abs()

    merged["targetReliable"] = (
        (merged["predictionErrorSeconds"] <= 120)
        & (merged["etaMinutes"] >= 0)
        & (merged["etaMinutes"] <= 45)
    ).astype(int)

    merged = merged.dropna(subset=FEATURE_COLUMNS)
    for column in FEATURE_COLUMNS:
        merged[column] = pd.to_numeric(merged[column], errors="coerce").fillna(0.0)

    return merged


def split_by_time(frame: pd.DataFrame, test_fraction: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    ordered = frame.sort_values("observedAt").reset_index(drop=True)
    split_index = max(1, min(len(ordered) - 1, int(len(ordered) * (1 - test_fraction))))
    train = ordered.iloc[:split_index].copy()
    test = ordered.iloc[split_index:].copy()

    if train.empty or test.empty:
        raise ValueError("Need both train and test windows for time-based validation.")

    if train["targetReliable"].nunique() < 2 or test["targetReliable"].nunique() < 2:
        raise ValueError(
            "Time-based split needs both reliable and unreliable examples in train and test windows."
        )

    return train, test


def train_model(frame: pd.DataFrame, test_fraction: float) -> tuple[LogisticRegression, dict]:
    if frame["targetReliable"].nunique() < 2:
        raise ValueError("Need both reliable and unreliable examples before training.")

    train_frame, test_frame = split_by_time(frame, test_fraction)

    x_train = train_frame[FEATURE_COLUMNS]
    x_test = test_frame[FEATURE_COLUMNS]
    y_train = train_frame["targetReliable"]
    y_test = test_frame["targetReliable"]

    model = LogisticRegression(max_iter=1500)
    model.fit(x_train, y_train)

    probabilities = model.predict_proba(x_test)[:, 1]
    predictions = (probabilities >= 0.5).astype(int)

    metrics = {
        "rows": int(len(frame)),
        "positive_rate": float(frame["targetReliable"].mean()),
        "train_rows": int(len(train_frame)),
        "test_rows": int(len(test_frame)),
        "train_window_start": train_frame["observedAt"].min().isoformat(),
        "train_window_end": train_frame["observedAt"].max().isoformat(),
        "test_window_start": test_frame["observedAt"].min().isoformat(),
        "test_window_end": test_frame["observedAt"].max().isoformat(),
        "roc_auc": float(roc_auc_score(y_test, probabilities)),
        "classification_report": classification_report(y_test, predictions, output_dict=True),
    }

    return model, metrics


def export_artifact(model: LogisticRegression, output_path: Path) -> None:
    artifact = {
        "version": 1,
        "target": "arrival_prediction_within_2_minutes",
        "trainedAt": pd.Timestamp.now(tz="UTC").isoformat(),
        "featureOrder": FEATURE_COLUMNS,
        "intercept": float(model.intercept_[0]),
        "coefficients": {
            feature_name: float(weight)
            for feature_name, weight in zip(FEATURE_COLUMNS, model.coef_[0], strict=True)
        },
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(artifact, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the Guelph Transit Pulse arrival reliability model.")
    parser.add_argument(
        "--snapshots",
        default="data/ml/arrival_snapshots.ndjson",
        help="Path to the logged arrival snapshot NDJSON file.",
    )
    parser.add_argument(
        "--artifact",
        default="ml/artifacts/arrival_reliability_model.json",
        help="Where to write the exported model artifact.",
    )
    parser.add_argument(
        "--training-csv",
        default="ml/artifacts/arrival_training_frame.csv",
        help="Where to write the derived training frame for inspection.",
    )
    parser.add_argument(
        "--metrics-json",
        default="ml/artifacts/arrival_reliability_metrics.json",
        help="Where to write model evaluation metrics as JSON.",
    )
    parser.add_argument(
        "--test-fraction",
        type=float,
        default=0.2,
        help="Fraction of the newest rows reserved for time-based validation.",
    )
    parser.add_argument(
        "--min-rows",
        type=int,
        default=500,
        help="Minimum number of labeled rows required before training.",
    )
    args = parser.parse_args()

    snapshots_path = Path(args.snapshots)
    artifact_path = Path(args.artifact)
    training_csv_path = Path(args.training_csv)
    metrics_json_path = Path(args.metrics_json)

    frame = load_snapshots(snapshots_path)
    training_frame = build_training_frame(frame)
    if len(training_frame) < args.min_rows:
        raise ValueError(
            f"Need at least {args.min_rows} labeled rows before training; found {len(training_frame)}."
        )
    training_csv_path.parent.mkdir(parents=True, exist_ok=True)
    training_frame.to_csv(training_csv_path, index=False)

    model, metrics = train_model(training_frame, args.test_fraction)
    export_artifact(model, artifact_path)
    metrics_json_path.parent.mkdir(parents=True, exist_ok=True)
    metrics_json_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print(json.dumps(metrics, indent=2))
    print(f"Artifact written to {artifact_path}")
    print(f"Training frame written to {training_csv_path}")
    print(f"Metrics written to {metrics_json_path}")


if __name__ == "__main__":
    main()

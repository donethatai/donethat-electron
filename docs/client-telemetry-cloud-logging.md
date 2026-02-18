# Client Telemetry Cloud Logging Integration

This repo now sends optional `clientTelemetry` in capture payloads:
- `captureScreenshot` path (cloud capture flow)
- `inputProcess` path (local processing flow)
- includes a capped `logs` array (max 50 entries per cycle) aggregated across main + renderer/webview consoles

Cloud Functions code is not in this repository. Add handling there to persist telemetry into Cloud Logging.

## What To Log

For each request that includes `clientTelemetry`, write one structured log entry:

- `event`: `"client_capture_telemetry"`
- `clientTelemetry`: full object from request
- `uidHash`: hash of authenticated uid (no raw uid)
- `appVersion`: `clientTelemetry.dimensions.appVersion`
- `platform`: `clientTelemetry.dimensions.platform`
- `os`: `clientTelemetry.dimensions.os`
- `captureIntervalMin`: `clientTelemetry.dimensions.captureIntervalMin`

Use log severity `INFO`.

## Recommended Log-Based Metrics

Create metrics from `jsonPayload.clientTelemetry`:

1. Distribution: `capture_cycle_duration_ms`
- Field: `jsonPayload.clientTelemetry.captureCycleDurationMs`

2. Distribution: `memory_rss_mb`
- Field: `jsonPayload.clientTelemetry.memoryMb.rss`

3. Counter: `screen_lock_timeout_count`
- Increment by sum of `timeoutCount` in `jsonPayload.clientTelemetry.counters.screenLock[*]`

4. Counter: `audio_restart_action_count`
- Count entries in `jsonPayload.clientTelemetry.counters.audioRestart[*]` grouped by `reason` and `action`

5. Counter: `permission_check_count`
- Sum `count` from `jsonPayload.clientTelemetry.counters.permissionChecks[*]` grouped by `type`, `source`, `result`

6. Counter: `active_window_probe_timeout_count`
- Field: `jsonPayload.clientTelemetry.counters.activeWindowProbeTimeoutCount`

## Recommended Alerts

1. p95 capture duration high
- Metric: `capture_cycle_duration_ms`
- Condition: p95 above threshold for 15 minutes
- Group by: `appVersion`, `platform`

2. Memory growth
- Metric: `memory_rss_mb`
- Condition: sustained positive trend over 60 minutes
- Group by: `appVersion`, `platform`

3. Churn spike
- Metrics: `screen_lock_timeout_count`, `audio_restart_action_count`, `permission_check_count`
- Condition: spike above baseline
- Group by: `appVersion`, `platform`

## Safety

- Treat telemetry logging as best effort.
- Do not fail capture requests if telemetry processing/logging fails.
- Keep only low-cardinality dimensions in labels.

# Counterfactual

Counterfactual is a small browser workflow for reviewing an explicit queue model and comparing the same finite cohort with a staffing change. This first slice is intentionally exploratory: arrivals, service demands, and the empty initial state are assumptions, and staffing results are unvalidated model predictions.

## Run the demo

Node.js 24 or newer is required for the documented `.env` startup command. No package installation is needed. Fresh uploads also require `ffprobe` and `ffmpeg` on `PATH`.

```sh
node --env-file-if-exists=.env src/server.js
```

Open http://127.0.0.1:3000. Enter the baseline service positions and finite arrival schedule, save the inputs, confirm the reviewed model, then run the staffing what-if. The sample schedule is the synthetic scenario from the workflow spec: arrivals at 0, 1, and 2 seconds with five-second service demands.

## Run the tests

```sh
npm test
```

The tests exercise the public HTTP workflow. They cover review and stale-edit rules, invalid inputs, the deterministic one-position/two-position comparison, identical staffing, zero-wait comparisons, and the browser playback surface. The result view has one shared clock with play, pause, replay, and time seeking controls; the schematic is driven by the returned event timelines.

## Workflow API

The server keeps models in memory. `POST /api/models` creates a draft from `{ baselinePositions, arrivals, initialState: { kind: "empty" } }`. `POST /api/models/:id/review` confirms the current `version` with `{ expectedVersion }`. `POST /api/models/:id/compare` runs a live deterministic comparison with `{ reviewedVersion, interventionPositions }`. `PUT /api/models/:id` edits inputs and increments the version, which invalidates review and comparisons. A comparison contains both customers' event timelines and waiting times, queue-length timelines, mean waiting times, assumptions, and an explicit unvalidated-prediction status.

## Prepared footage and analysis provenance

The prepared route at `GET /api/analysis/prepared` loads `data/prepared-analysis.json` and the matching `public/media/prepared-checkout.mp4`. The clip is the exact 36-second, 640×360, 5 fps copy used for the saved SAM 3.1 and Muse Wonder 1.0 analysis. The fixture keeps clip identity, source and Pexels license links, processed-frame count, explicit processed frame indices, representative detections, candidate zones, limitations, and an evidence qualification verdict. It is deliberately marked insufficient for calibration because the queue entrance and complete waits are not visible. The footage is an exploratory integration example, not a measured queue.

The fresh upload route is `POST /api/analysis/upload` (multipart field `video`). It returns a bounded job id; poll `GET /api/analysis/uploads/:id` until the status is `completed` or `failed`. Completed uploads use the same normalized analysis contract and can be reviewed at `POST /api/analysis/:analysisId/review`; the uploaded video is available at `/api/analysis/uploads/:id/video` for that process. Supported inputs are MP4, WebM, and QuickTime, up to 25 MB and 180 seconds. Processing is capped at 900 frames at 5 fps after a 640×360 transcode. The server rejects invalid media, malformed or incomplete SAM streams, incomplete Wonder output, provider failures, and oversized requests without falling back to the prepared fixture. Failed jobs expose a retry path in the browser and the explicit prepared-demo choice remains available.

Set `MODEL_API_KEY` in a local `.env` file for real Meta inference. The key is read by the server-side adapter only. Do not put it in browser code, fixtures, logs, or error responses. The prepared demo does not need a key.

`POST /api/analysis/:analysisId/review` accepts corrected `zones`, `observations`, `baselinePositions`, and explicit assumptions. Every accepted event and zone must carry a `video` reference with a timestamp interval or an `assumption` reference with a reason. The response reports complete waits separately from incomplete cases and returns `proposedModelInputs.evidenceReview`; passing those inputs to `POST /api/models` preserves the analysis id, review version, and exploratory or qualified evidence status into the live comparison.

The reusable adapter seam is `validateAnalysis` plus `parseSamOutput` in `src/analysis.js`. Future upload analysis should map provider responses into the same normalized contract before it reaches the review endpoint. SAM frame markers are explicit processed frame indices and can be sparse, so the adapter maps `frameIndex / processedFps` rather than using a response line number. Provider credentials and raw response bodies remain server-side scratch material and are not fixtures.

## Plain-language staffing requests

After the model is reviewed, `POST /api/models/:id/staffing/interpret` accepts `{ request }` and returns a pending interpretation. The server sends the bounded request to Muse Wonder with a strict JSON schema, validates the returned position count locally, and records the current reviewed-model version. The browser shows the baseline and proposed count before the user confirms it.

Confirmation uses `POST /api/models/:id/staffing/confirm` with `{ proposalId }`. Only this route runs the existing deterministic simulator. A changed model version, unsupported interpretation, malformed provider response, or provider failure cannot run a comparison. The explicit position-count control remains available when interpretation is unavailable. `MODEL_API_KEY` is read only by the server-side adapter.

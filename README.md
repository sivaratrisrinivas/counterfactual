# Counterfactual

Counterfactual is a small browser workflow for reviewing an explicit queue model and comparing the same finite cohort with a staffing change. This first slice is intentionally exploratory: arrivals, service demands, and the empty initial state are assumptions, and staffing results are unvalidated model predictions.

## Run the demo

Node.js 20 or newer is required. No package installation is needed.

```sh
npm start
```

Open http://127.0.0.1:3000. Enter the baseline service positions and finite arrival schedule, save the inputs, confirm the reviewed model, then run the staffing what-if. The sample schedule is the synthetic scenario from the workflow spec: arrivals at 0, 1, and 2 seconds with five-second service demands.

## Run the tests

```sh
npm test
```

The tests exercise the public HTTP workflow. They cover review and stale-edit rules, invalid inputs, the deterministic one-position/two-position comparison, identical staffing, zero-wait comparisons, and the browser playback surface. The result view has one shared clock with play, pause, replay, and time seeking controls; the schematic is driven by the returned event timelines.

## Workflow API

The server keeps models in memory. `POST /api/models` creates a draft from `{ baselinePositions, arrivals, initialState: { kind: "empty" } }`. `POST /api/models/:id/review` confirms the current `version` with `{ expectedVersion }`. `POST /api/models/:id/compare` runs a live deterministic comparison with `{ reviewedVersion, interventionPositions }`. `PUT /api/models/:id` edits inputs and increments the version, which invalidates review and comparisons. A comparison contains both customers' event timelines and waiting times, queue-length timelines, mean waiting times, assumptions, and an explicit unvalidated-prediction status.

# Demo feasibility findings

Research date: 2026-11-01. These are findings and unresolved checks, not an implementation spec.

## Model integration

- Meta documents `sam-3.1` video segmentation with a concept prompt such as `person`, producing per-frame geometry. Stable identities are limited to continuous visibility; entry, exit, and full occlusion require care. Sources: [prompting](https://dev.meta.ai/docs/sam/segmenting), [output semantics](https://dev.meta.ai/docs/sam/reading-segmentation).
- Meta documents `muse-wonder-1.0` with video input and structured output. This supports the proposed model-interpretation interface; it does not establish that inferred timings or service structure will be correct. Source: [model documentation](https://dev.meta.ai/docs/models).
- The live spike below verified account access and successful responses from both models. It does not establish tracking accuracy or the validity of a queue simulator.

## Footage search

A bounded search did not establish a source that satisfies all requirements: usable rights, a fixed camera, a visible shared queue and service positions, and enough continuous observations to estimate waiting and service times. This is a search result, not evidence that no such source exists.

The strongest initial lead was [Busy Retail Checkout During Super Friday Event](https://www.pexels.com/video/busy-retail-checkout-during-super-friday-event-35042443/). Its source page lists a 36-second duration and describes a worker assisting customers at a checkout. Direct inspection of downloaded sample frames and live model analysis now reject it as calibration footage: this is a close view of a checkout with background pedestrians, not an observable shared queue. The queue entrance and complete waiting/service episodes are not visible. This supersedes the preliminary browser-based suggestion that a shared waiting area might be usable. The clip remains useful for integration testing.

[Pexels' license](https://www.pexels.com/license/) permits free use and modification, including use in an app or presentation, subject to restrictions including no implied endorsement. It is an asset-specific license, not the repository's software license.

Shorter leads include [a nine-second supermarket checkout clip](https://www.pexels.com/video/people-paying-at-the-counter-in-the-supermarket-4249560/) and [a fifteen-second airport queue clip](https://www.pexels.com/video/crowd-of-travelers-lining-up-at-busy-airport-terminal-29576548/). Neither has been established as adequate calibration data.

## Decision gate

Inspect candidate footage before selecting it. Count complete observable waits and service episodes, identify partial observations, and check whether arrivals and service areas remain visible. Then test the real analysis pipeline on a small clip before committing to the full interface.

If footage supports only counts or partial events, use only those as observations. Any user-supplied timings remain assumptions in an exploratory model. A working upload-to-what-if demonstration is distinct from evidence that the staffing prediction is accurate; see [ADR-0004](../adr/0004-use-existing-footage-for-a-solo-demo.md).

## Live API spike

The user authorized use of `MODEL_API_KEY` from `.env`. The key was loaded locally, sent only as an authorization header to `https://api.meta.ai`, and excluded from logs and Git. The local scratch directory is also ignored.

The licensed checkout clip was downsampled to 640 x 360 at 5 fps, without audio: 36 seconds, 180 frames, 1,303,581 bytes. It was uploaded once, then used for one request to each model. Neither request was retried.

| Check | Observed result |
| --- | --- |
| Model catalog | Both `sam-3.1` and `muse-wonder-1.0` listed |
| SAM video segmentation | Completed in 22.87 seconds; 180 frame records and 180 billed frames |
| Parsed person detections | 3–12 detections per frame; 16 distinct IDs across the clip |
| Wonder video assessment | Completed in 17.45 seconds; 2,797 input tokens and 1,289 output tokens |
| Wonder response format | Valid JSON requested by prompt and parsed locally; schema-constrained output was not exercised |
| Calibration suitability | Rejected: no visible formed queue and no complete observable service episode |

These are single-request wall-clock measurements, not latency benchmarks. Detection totals are model output, not ground-truth person counts or queue lengths. Four sampled overlays were inspected: they include staff and unrelated background pedestrians, demonstrating why zone and role filtering are necessary. Full tracking accuracy and ID-switch rates were not measured.

Wonder explicitly declined to infer arrival rates, service times, waiting times, or staffing-intervention validity from the clip. Its assessment agrees with the sampled visual inspection, but its output is still a model assessment rather than independent ground truth.

At the [published Standard-mode rates](https://dev.meta.ai/docs/pricing-rate-limits), the reported usage implies approximately $0.036 for SAM and $0.036968 for Wonder: **$0.072968 total inference cost**. This is a usage-based estimate, not a billing-dashboard reconciliation.

### Reproduction

Use Node.js 24 and [scripts/meta-spike.mjs](../../scripts/meta-spike.mjs). The script reads `.env` directly; no key belongs in command arguments. Commands run from the repository root:

```sh
node scripts/meta-spike.mjs models
node scripts/meta-spike.mjs upload .scratch/meta-spike/checkout-36s.mp4
node scripts/meta-spike.mjs wonder
node scripts/meta-spike.mjs sam
```

The upload command accepts another local MP4. The two inference commands use the latest saved upload, so rerunning either makes a new billable request. This is a feasibility script, not a production API client.

Local artifacts under `.scratch/meta-spike/` include the downsampled clip, raw responses, parsed boxes, Wonder's assessment, and `tracking-inspection.jpg`. They are not committed or relicensed as repository code. Production deployment, structured model generation, simulator correctness, reliable event extraction, and live what-if latency remain untested.

### Routing consequence

The API integration risk is reduced; the evidence-data risk remains. A build spec can now require an explicit exploratory mode with labeled assumptions, while keeping qualification of real calibration footage as a blocking task for any measured waiting-time claim. The rejected checkout clip must not silently become the proof clip.

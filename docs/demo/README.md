# Counterfactual demo package

This directory holds the local rehearsal notes and the presentation recording for the first Counterfactual slice. The prepared route is the reproducible path for a three-minute demonstration. It loads the exact checkout clip that produced the saved SAM 3.1 and Muse Wonder analysis in `data/prepared-analysis.json`; it does not run video inference while the presentation starts.

## Run locally

Use Node.js 24 or newer. The fresh upload route also needs `ffprobe` and `ffmpeg` on `PATH`.

```sh
cp .env.example .env
# Set MODEL_API_KEY in .env only when testing a live Meta adapter.
npm start
```

Open `http://127.0.0.1:3000`. The prepared analysis is available without a key. The browser journey is:

1. Inspect the saved clip, provenance, overlay boxes, source rights, and evidence limitations.
2. Confirm the one shared queue review with the explicit empty initial state. The clip is rejected as calibration evidence, so the sample timings stay assumptions.
3. Save and confirm the reviewed model, then run the explicit two-position staffing control.
4. Inspect the computed four-second baseline versus one-second intervention mean waiting times and the synchronized replay. The result is an unvalidated model prediction.

The plain-language staffing panel is a live Muse Wonder request. It displays the proposed count and waits for confirmation before calling the deterministic simulator. The explicit staffing control remains available if the provider is unavailable.

Fresh uploads are bounded to MP4, WebM, or QuickTime, 25 MB, 180 seconds, and 900 processed frames at 5 fps after a 640×360 transcode. A failed job offers a retry and a visible return to the prepared demo. Uploaded media rights are not verified by this application. It is not a fallback source for the prepared clip.

## Recording

The recording script follows the UI demo workflow's discover, rehearse, record sequence. The repository stays dependency-free. Install Playwright separately or point `COUNTERFACTUAL_PLAYWRIGHT` at an existing module:

```sh
COUNTERFACTUAL_PLAYWRIGHT=/tmp/counterfactual-browser/node_modules/playwright/index.mjs \
COUNTERFACTUAL_CHROMIUM=/home/srinivas/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell \
node scripts/record-demo.mjs --rehearse

COUNTERFACTUAL_PLAYWRIGHT=/tmp/counterfactual-browser/node_modules/playwright/index.mjs \
COUNTERFACTUAL_CHROMIUM=/home/srinivas/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell \
node scripts/record-demo.mjs
```

The script writes `docs/demo/counterfactual-demo.webm` and a small set of inspection screenshots. The recording uses the explicit staffing control, so it does not make a paid language request. It describes SAM as the segmentation source, Wonder as scene interpretation, and the simulator as the source of comparison metrics. It does not describe the checkout clip as a studied queue or claim intervention validation.

## Evidence and attribution

The prepared clip is “Busy Retail Checkout During Super Friday Event” by Michael Takahashi, from [Pexels](https://www.pexels.com/video/busy-retail-checkout-during-super-friday-event-35042443/). The [Pexels license](https://www.pexels.com/legal-pages/license/) permits free use and modification subject to its restrictions. Visible people, brands, and logos may carry rights beyond the media license; the demo makes no endorsement claim. This media attribution is separate from the software license.

The clip has no visible queue entrance and no complete queue-join/service-start episode for a reviewed person. Its detections are evidence to inspect, not queue counts or measured waits. The comparison uses explicit synthetic arrivals at 0, 1, and 2 seconds, five-second service demands, and an empty initial state. Those values remain assumptions.

## Submission checklist

Before any event submission, manually verify the current event rules and replace this local checklist with the final public links. This task does not submit or publish an entry.

- [ ] Public repository link and software license
- [ ] Running product link or local presentation environment
- [ ] Three-minute recording inspected from start to finish
- [ ] Footage source and media license credited separately
- [ ] `MODEL_API_KEY` absent from commits, fixtures, logs, and recording
- [ ] Prepared path reproduced without fresh inference
- [ ] Fresh-upload limits and rights caveat documented
- [ ] Remaining limitations stated: rejected calibration clip, exploratory assumptions, and unvalidated staffing prediction

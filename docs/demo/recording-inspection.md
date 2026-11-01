# Recording inspection

`counterfactual-demo.webm` is a 175.36-second recording made from the prepared route on 2026-11-02. It was recorded with the repository's `scripts/record-demo.mjs` against the local packaged server.

The recording was inspected at these points:

- Opening: the page labels the clip as saved analysis and shows the 25 MB / 180 second fresh-upload limits.
- Evidence: the video overlay and saved provenance are visible, with the calibration rejection and evidence limits on screen.
- Review: the prepared clip produces zero complete observed waits, then explicit synthetic arrivals and service demands are saved as assumptions.
- Comparison: the reviewed model shows 4 seconds baseline mean waiting time, 1 second intervention mean waiting time, and the synchronized replay at a service boundary.
- Closing: the recording labels the comparison as an unvalidated model prediction and leaves the fresh-upload retry/prepared-demo path visible.

The browser acceptance check also submitted a deliberately invalid local file. The page showed `The uploaded file is not a readable MP4 or QuickTime video.` and did not invoke either model adapter. The captured recovery state is `04-invalid-upload.png`; the expected HTTP 400 is the only console error in that negative-path check.

The recording uses the explicit staffing control and makes no paid language request. The UI text names SAM as segmentation, Muse Wonder as interpretation, and the deterministic simulator as the source of the comparison. It does not claim the checkout clip is calibrated or that staffing was physically validated.

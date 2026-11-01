# Production adapter smoke check

This is a bounded integration check on the exact public prepared asset. It verifies the server-side upload, SAM 3.1 segmentation, and Muse Wonder interpretation adapters. It is not calibration evidence and does not validate a staffing intervention.

- Checked: 2026-11-02 00:18 IST (2026-11-01 18:48 UTC)
- Asset: `public/media/prepared-checkout.mp4`
- SHA-256: `c0b3069d33217513f1b2f5bd3531f5c8b6eb998256865c9096fe67a23bf18a0b`
- Result: completed in 43.04 seconds
- Processing: 640×360, 5 fps, 180 frames
- SAM 3.1: HTTP 200, 22 seconds, completed, 180 video frames processed
- Muse Wonder 1.0: HTTP 200, 12.71 seconds, completed, 2,694 input tokens and 875 output tokens
- Qualification: unsuitable for calibration; locally `calibrationEligible: false`

The sampled overlays at approximately 0, 10, 20, and 35 seconds show a staff member, a customer already at the counter, partial people at the edge, and background pedestrians. The clip has no visible formed shared queue, queue entrance, or complete queue-join/service-start episode. The raw model output remains private scratch data. Only the sanitized provenance and verdict belong in the repository.

This check establishes adapter connectivity and response handling. It does not turn detections into queue length, waiting time, service duration, or intervention validation. The prepared browser route remains an evidence-limited exploratory example.

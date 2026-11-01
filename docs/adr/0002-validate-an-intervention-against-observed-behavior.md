---
status: superseded by ADR-0004
---

# Validate an intervention against observed behavior

Volunteer availability was not confirmed, so [ADR-0004](0004-use-existing-footage-for-a-solo-demo.md) replaces the required physical intervention experiment. The distinction between calibration and intervention validation, and the requirement to report unfinished waits, remain applicable.

The demo will calibrate on footage of the baseline, record a prediction for a physical intervention, then compare it with observations of the changed setup. Matching the footage used for calibration will be described as calibration fit, not evidence that a what-if prediction is accurate; prediction error will remain visible. This requires a second physical setup and recording, but gives stronger evidence than an attractive simulated comparison alone and does not establish accuracy for other interventions or locations.

Average waiting time is the headline outcome, supported by queue length over time. People still waiting when a recording ends must be reported explicitly rather than silently excluded.

Both recordings will use the same planned arrival schedule and equivalent check-in tasks, with the number of attendants as the intended difference. New arrivals stop at a fixed point, and recording continues until everyone finishes. Actual arrival and service timings must still be measured: the planned schedule is an experimental control, not a substitute for observations, and unintended differences may limit the comparison.

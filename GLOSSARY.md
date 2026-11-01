# Counterfactual

Counterfactual explores changes to a physical place through a behavior simulator built from video of that place.

## Language

**Behavior simulator**:
A model of how people or vehicles move through a place and use its services over time.
_Avoid_: 3D replica

**What-if**:
A hypothetical change to the modeled system whose simulated outcome can be compared with the system without that change.
_Avoid_: Guaranteed forecast

**Baseline**:
The original service setup against which a proposed change is compared.

**Intervention**:
A deliberate change to the service setup, represented in a what-if and optionally tested in the physical scene.

**Calibration**:
Fitting the behavior simulator to observations of the baseline.
_Avoid_: Prediction validation

**Intervention validation**:
Comparing a prediction made before observing the changed setup with measurements from that setup.
_Avoid_: Calibration fit

**Waiting time**:
The elapsed time between a person joining the queue and beginning service; time spent receiving service is excluded.
_Avoid_: Total visit time

**Queue length**:
The number of people waiting to begin service at a particular time; people already receiving service are excluded.
_Avoid_: Crowd size

**Reviewed model**:
A behavior model whose inferred structure, timings, and assumptions have been presented to the user for confirmation or correction before a what-if is run.

**Arrival schedule**:
The times at which people join the queue during an observation or experiment. A planned schedule specifies intended arrivals; an observed schedule records actual arrivals.

**Observation**:
A measurement of the recorded scene, such as a queue count or service start time, with a traceable connection to the footage. Observations may require correction when detection or interpretation is wrong.

**Assumption**:
A condition or value used by the behavior simulator that has not been established from observations of the scene.
_Avoid_: Measured fact

const EPSILON = 0.000001;
const SERVICE_START_EVENT = 'service-start';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[character]));
}

function formatSeconds(value) {
  const seconds = Number(value);
  return `${seconds.toFixed(seconds % 1 ? 1 : 0)}s`;
}

function maxEventTime(scenario) {
  return Math.max(0, ...scenario.events.map((event) => event.time));
}

function queueLengthAt(scenario, time) {
  const points = scenario.queueLengthTimeline ?? [];
  let value = 0;
  for (const point of points) {
    if (point.time > time + EPSILON) break;
    value = point.queueLength;
  }
  return value;
}

function scenarioMarkup(key, scenario, label, accent) {
  const positionRows = Array.from({ length: scenario.positions }, (_, index) => `
    <div class="position-row" data-position="${index + 1}">
      <span class="position-label">Position ${index + 1}</span>
      <div class="service-cell" data-service>Idle</div>
    </div>`).join('');
  return `<section class="scenario-lane ${accent}" data-scenario="${key}">
    <header class="scenario-header">
      <div><span class="lane-title">${label}</span><strong>${scenario.positions} ${scenario.positions === 1 ? 'position' : 'positions'}</strong></div>
      <span class="lane-state" data-lane-state>Queue 0 · 0 serving</span>
    </header>
    <div class="scenario-queue">
      <div class="queue-label"><span>Waiting queue</span><strong data-queue-count>0</strong></div>
      <div class="queue-people" data-queue-people><span class="empty-queue">No one has arrived</span></div>
    </div>
    <div class="scenario-positions">${positionRows}</div>
    <p class="cohort-status" data-cohort-status>Waiting for the first arrival.</p>
  </section>`;
}

function customerStatus(customer, time) {
  if (customer.serviceEndTime <= time + EPSILON) return 'complete';
  if (customer.serviceStartTime <= time + EPSILON && customer.serviceEndTime > time + EPSILON) return 'service';
  if (customer.arrivalTime <= time + EPSILON) return 'waiting';
  return 'not-arrived';
}

function customerLabel(customer) {
  return escapeHtml(customer.id);
}

function renderLane(root, key, scenario, time) {
  const lane = root.querySelector(`[data-scenario="${key}"]`);
  if (!lane) return;
  const statuses = scenario.customers.map((customer) => ({ customer, status: customerStatus(customer, time) }));
  const waiting = statuses.filter(({ status }) => status === 'waiting');
  const serving = statuses.filter(({ status }) => status === 'service');
  const completed = statuses.filter(({ status }) => status === 'complete');
  const arrived = statuses.filter(({ status }) => status !== 'not-arrived');
  const started = scenario.events.some((event) => event.type === SERVICE_START_EVENT && event.time <= time + EPSILON);
  const traceQueueLength = queueLengthAt(scenario, time);

  lane.querySelector('[data-queue-count]').textContent = String(traceQueueLength);
  lane.querySelector('[data-lane-state]').textContent = `Queue ${traceQueueLength} · ${serving.length} serving`;
  lane.querySelector('[data-queue-people]').innerHTML = waiting.length
    ? waiting.map(({ customer }) => `<span class="person-token waiting-token" title="${customerLabel(customer)}">${customerLabel(customer)}</span>`).join('')
    : arrived.length === 0
      ? '<span class="empty-queue">No one has arrived</span>'
      : traceQueueLength === 0 && completed.length === scenario.customers.length
        ? '<span class="empty-queue">Queue empty · cohort complete</span>'
        : '<span class="empty-queue">Queue is clear</span>';

  lane.querySelectorAll('[data-position]').forEach((row) => {
    const position = Number(row.dataset.position);
    const active = serving.find(({ customer }) => customer.position === position);
    const serviceCell = row.querySelector('[data-service]');
    if (!active) {
      serviceCell.className = 'service-cell idle-service';
      serviceCell.innerHTML = '<span>Idle</span>';
      return;
    }
    const { customer } = active;
    serviceCell.className = 'service-cell active-service';
    serviceCell.innerHTML = `<strong>${customerLabel(customer)}</strong><span>serving · ${formatSeconds(customer.serviceEndTime - time)} left</span>`;
  });

  const status = lane.querySelector('[data-cohort-status]');
  if (completed.length === scenario.customers.length) {
    status.textContent = `All ${scenario.customers.length} people departed.`;
  } else if (arrived.length === 0) {
    status.textContent = 'Waiting for the first arrival.';
  } else {
    status.textContent = `${completed.length} departed · ${serving.length} serving · ${waiting.length} waiting${started ? '' : ' to start'}.`;
  }
}

export function renderPlayback(comparison, root = document) {
  const frame = root.querySelector('#playback-frame');
  const slider = root.querySelector('#playback-time');
  const clock = root.querySelector('#playback-clock');
  const toggle = root.querySelector('#playback-toggle');
  const replay = root.querySelector('#playback-replay');
  const playbackState = root.querySelector('#playback-state');
  if (!frame || !slider || !clock || !toggle || !replay || !playbackState) return null;

  const duration = Math.max(maxEventTime(comparison.baseline), maxEventTime(comparison.intervention), 0.1);
  slider.max = String(duration);
  slider.value = '0';
  frame.innerHTML = `${scenarioMarkup('baseline', comparison.baseline, 'Baseline', 'baseline-lane')}${scenarioMarkup('intervention', comparison.intervention, 'Intervention', 'intervention-lane')}`;

  let currentTime = 0;
  let playing = false;
  let animationFrame = null;
  let lastTimestamp = null;

  function update(nextTime) {
    currentTime = Math.max(0, Math.min(duration, nextTime));
    slider.value = String(currentTime);
    clock.textContent = `${formatSeconds(currentTime)} / ${formatSeconds(duration)}`;
    renderLane(frame, 'baseline', comparison.baseline, currentTime);
    renderLane(frame, 'intervention', comparison.intervention, currentTime);
  }

  function setPlaying(nextPlaying) {
    playing = nextPlaying;
    toggle.textContent = playing ? 'Pause' : 'Play';
    playbackState.textContent = playing ? 'Playing' : currentTime >= duration ? 'Complete' : 'Paused';
  }

  function tick(timestamp) {
    if (!playing) return;
    if (lastTimestamp === null) lastTimestamp = timestamp;
    update(currentTime + (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;
    if (currentTime >= duration) {
      setPlaying(false);
      lastTimestamp = null;
      animationFrame = null;
      return;
    }
    animationFrame = requestAnimationFrame(tick);
  }

  toggle.onclick = () => {
    if (playing) {
      setPlaying(false);
      lastTimestamp = null;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = null;
      return;
    }
    if (currentTime >= duration) update(0);
    setPlaying(true);
    animationFrame = requestAnimationFrame(tick);
  };
  replay.onclick = () => {
    setPlaying(false);
    lastTimestamp = null;
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    update(0);
  };
  slider.oninput = () => {
    setPlaying(false);
    lastTimestamp = null;
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    update(Number(slider.value));
  };

  update(0);
  return {
    destroy() {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      toggle.onclick = null;
      replay.onclick = null;
      slider.oninput = null;
    },
    get time() {
      return currentTime;
    },
  };
}

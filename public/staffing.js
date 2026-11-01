const shell = document.querySelector('.what-if');
let currentModel = null;
let currentProposal = null;

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));

if (shell) {
  const panel = document.createElement('div');
  panel.className = 'language-panel';
  panel.innerHTML = `
    <div class="language-heading">
      <div><span class="step">Language request</span><h3>Ask for a staffing change</h3></div>
      <span class="tag intervention-tag">Server interpreted</span>
    </div>
    <p class="language-intro">Try “add another service position.” The request is interpreted against the reviewed model, then shown for confirmation.</p>
    <form id="staffing-form" class="staffing-form">
      <label class="field-label" for="staffing-request">What should change?</label>
      <div class="staffing-form-row"><input id="staffing-request" name="request" maxlength="2000" placeholder="Add another service position" required><button class="secondary-button" type="submit">Interpret request</button></div>
    </form>
    <div id="staffing-proposal" class="staffing-proposal" hidden></div>`;
  shell.append(panel);

  const form = panel.querySelector('#staffing-form');
  const requestInput = panel.querySelector('#staffing-request');
  const proposalOutput = panel.querySelector('#staffing-proposal');

  function showProposal(proposal) {
    currentProposal = proposal;
    proposalOutput.hidden = false;
    const proposed = proposal.proposedInterventionPositions === null
      ? 'No executable position count'
      : `${proposal.proposedInterventionPositions} position${proposal.proposedInterventionPositions === 1 ? '' : 's'}`;
    const action = proposal.status === 'pending'
      ? `<button id="confirm-staffing" class="primary-button" type="button"><span>Confirm ${escapeHtml(proposed)}</span><b>↗</b></button>`
      : '';
    proposalOutput.innerHTML = `<div class="proposal-summary"><span class="field-label">Interpretation</span><strong>${escapeHtml(proposal.baselinePositions)} → ${escapeHtml(proposed)}</strong><span class="proposal-status">${escapeHtml(proposal.status)}</span><p>${escapeHtml(proposal.explanation)}</p>${action}</div>`;
    const confirmButton = proposalOutput.querySelector('#confirm-staffing');
    if (confirmButton) confirmButton.addEventListener('click', confirmProposal);
  }

  async function request(path, options = {}) {
    const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'The staffing request could not be completed.');
    return body;
  }

  async function confirmProposal() {
    if (!currentModel || !currentProposal) return;
    try {
      const result = await request(`/api/models/${currentModel.id}/staffing/confirm`, {
        method: 'POST', body: JSON.stringify({ proposalId: currentProposal.id }),
      });
      showProposal(result.proposal);
      window.dispatchEvent(new CustomEvent('counterfactual:staffing-comparison', { detail: result.comparison }));
    } catch (error) {
      proposalOutput.innerHTML = `<div class="proposal-summary error-copy"><p>${escapeHtml(error.message)}</p><p>Use the explicit position control above or request a fresh interpretation.</p></div>`;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentModel?.reviewed) {
      proposalOutput.hidden = false;
      proposalOutput.innerHTML = '<div class="proposal-summary error-copy"><p>Confirm the reviewed model before asking for a staffing interpretation.</p></div>';
      return;
    }
    try {
      const result = await request(`/api/models/${currentModel.id}/staffing/interpret`, {
        method: 'POST', body: JSON.stringify({ request: requestInput.value }),
      });
      showProposal(result.proposal);
    } catch (error) {
      proposalOutput.hidden = false;
      proposalOutput.innerHTML = `<div class="proposal-summary error-copy"><p>${escapeHtml(error.message)}</p><p>The explicit position control remains available.</p></div>`;
    }
  });

  window.addEventListener('counterfactual:model-updated', (event) => {
    currentModel = event.detail;
    currentProposal = null;
    proposalOutput.hidden = true;
    requestInput.value = '';
  });
}


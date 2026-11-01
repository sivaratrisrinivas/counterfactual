import { randomUUID } from 'node:crypto';
import { WorkflowError } from './domain.js';

export const MAX_STAFFING_REQUEST_CHARS = 2000;
export const MAX_POSITIONS = 32;
const MAX_EXPLANATION_CHARS = 600;
const DEFAULT_TIMEOUT_MS = 30_000;

export class StaffingProviderError extends WorkflowError {
  constructor(message, status = 502) {
    super(message, status);
    this.name = 'StaffingProviderError';
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0 && value <= MAX_POSITIONS;

function providerText(response) {
  const text = response?.output
    ?.flatMap((item) => item?.content ?? [])
    ?.filter((item) => item?.type === 'output_text')
    ?.map((item) => typeof item.text === 'string' ? item.text : item.parsed ? JSON.stringify(item.parsed) : '')
    ?.join('')
    ?.trim();
  if (typeof text === 'string' && text) return text;
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  throw new StaffingProviderError('The staffing interpreter returned no structured result.');
}

function normalizeProviderResult(value) {
  if (!isRecord(value)) throw new StaffingProviderError('The staffing interpreter returned an invalid structured result.');
  if (typeof value.supported !== 'boolean') throw new StaffingProviderError('The staffing interpreter did not identify whether the request is supported.');
  if (typeof value.explanation !== 'string' || !value.explanation.trim() || value.explanation.length > MAX_EXPLANATION_CHARS) {
    throw new StaffingProviderError('The staffing interpreter returned an invalid explanation.');
  }
  const target = value.targetPositions;
  if (value.supported && !isPositiveInteger(target)) {
    throw new StaffingProviderError('The staffing interpreter returned an invalid position count.');
  }
  if (!value.supported && target !== null && target !== 0) {
    throw new StaffingProviderError('The unsupported staffing result contained an executable position count.');
  }
  return {
    supported: value.supported,
    targetPositions: value.supported ? target : null,
    explanation: value.explanation.trim(),
  };
}

export const STAFFING_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    supported: { type: 'boolean' },
    targetPositions: { type: ['integer', 'null'], minimum: 0, maximum: MAX_POSITIONS },
    explanation: { type: 'string' },
  },
  required: ['supported', 'targetPositions', 'explanation'],
});

export function createWonderStaffingProvider({
  apiKey = process.env.MODEL_API_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return async ({ request, baselinePositions }) => {
    if (!apiKey) throw new StaffingProviderError('Staffing interpretation is unavailable because MODEL_API_KEY is not configured.', 503);
    if (typeof fetchImpl !== 'function') throw new StaffingProviderError('Staffing interpretation is unavailable in this server environment.', 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const prompt = [
      'Interpret this user request for a staffing-only what-if in a reviewed queue model.',
      `The current reviewed model has ${baselinePositions} baseline service position${baselinePositions === 1 ? '' : 's'}.`,
      'Only a positive integral change to the number of independent parallel service positions is supported.',
      'Reject layout, service-speed, customer-behavior, multi-stage, or ambiguous requests.',
      'Return only the requested structured result. Do not calculate outcomes, waiting times, or executable logic.',
      `User request: ${request}`,
    ].join('\n');
    try {
      const response = await fetchImpl('https://api.meta.ai/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'muse-wonder-1.0',
          input: prompt,
          max_output_tokens: 800,
          reasoning: { effort: 'low' },
          text: {
            format: {
              type: 'json_schema',
              name: 'staffing_interpretation',
              strict: true,
              schema: STAFFING_RESPONSE_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new StaffingProviderError('The staffing interpreter could not process this request.');
      const payload = await response.json();
      if (payload.status !== 'completed') throw new StaffingProviderError('The staffing interpreter did not complete.');
      let parsed;
      try {
        parsed = JSON.parse(providerText(payload));
      } catch (error) {
        if (error instanceof StaffingProviderError) throw error;
        throw new StaffingProviderError('The staffing interpreter returned malformed structured output.');
      }
      return normalizeProviderResult(parsed);
    } catch (error) {
      if (error instanceof StaffingProviderError) throw error;
      if (error?.name === 'AbortError') throw new StaffingProviderError('The staffing interpreter timed out.');
      throw new StaffingProviderError('The staffing interpreter is unavailable.');
    } finally {
      clearTimeout(timer);
    }
  };
}

function boundedRequest(request) {
  if (typeof request !== 'string' || !request.trim()) throw new WorkflowError('Describe the staffing change in a short sentence.');
  const trimmed = request.trim();
  if (trimmed.length > MAX_STAFFING_REQUEST_CHARS) {
    throw new WorkflowError(`Staffing requests must be ${MAX_STAFFING_REQUEST_CHARS} characters or shorter.`);
  }
  return trimmed;
}

export class StaffingWorkflow {
  #modelWorkflow;
  #provider;
  #proposals = new Map();

  constructor(modelWorkflow, { provider = createWonderStaffingProvider() } = {}) {
    this.#modelWorkflow = modelWorkflow;
    this.#provider = provider;
  }

  async interpret(modelId, request) {
    const text = boundedRequest(request);
    const model = this.#modelWorkflow.getCurrent(modelId);
    if (!model.reviewed) throw new WorkflowError('Review the current model before asking for a staffing interpretation.', 409);
    let result;
    try {
      result = normalizeProviderResult(await this.#provider({
        request: text,
        baselinePositions: model.baselinePositions,
        modelVersion: model.version,
        maxPositions: MAX_POSITIONS,
      }));
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new StaffingProviderError('The staffing interpreter is unavailable.');
    }
    const proposal = {
      id: randomUUID(),
      modelId,
      modelVersion: model.version,
      request: text,
      baselinePositions: model.baselinePositions,
      proposedInterventionPositions: result.targetPositions,
      supported: result.supported,
      explanation: result.explanation,
      status: result.supported ? 'pending' : 'unsupported',
      createdAt: new Date().toISOString(),
      confirmedAt: null,
      comparison: null,
    };
    this.#proposals.set(proposal.id, proposal);
    return this.#viewProposal(proposal);
  }

  confirm(modelId, proposalId) {
    if (typeof proposalId !== 'string' || !proposalId) throw new WorkflowError('Choose an interpreted staffing change before confirming.');
    const proposal = this.#proposals.get(proposalId);
    if (!proposal || proposal.modelId !== modelId) throw new WorkflowError('This staffing interpretation was not found.', 404);
    if (proposal.status === 'unsupported') throw new WorkflowError('This request is unsupported. Use the explicit staffing control for a position-count what-if.', 422);
    const model = this.#modelWorkflow.getCurrent(modelId);
    if (!model.reviewed || model.version !== proposal.modelVersion) {
      throw new WorkflowError('This staffing interpretation is stale. Review the current model and request a fresh interpretation.', 409);
    }
    if (proposal.status === 'confirmed') {
      return { proposal: this.#viewProposal(proposal), comparison: structuredClone(proposal.comparison) };
    }
    const comparison = this.#modelWorkflow.compare(modelId, proposal.modelVersion, proposal.proposedInterventionPositions);
    proposal.status = 'confirmed';
    proposal.confirmedAt = new Date().toISOString();
    proposal.comparison = comparison;
    return { proposal: this.#viewProposal(proposal), comparison: structuredClone(comparison) };
  }

  #viewProposal(proposal) {
    const { comparison: _comparison, ...view } = proposal;
    return structuredClone(view);
  }
}

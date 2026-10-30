import { BridgeError, isRecord, asString } from './util.js';

export interface SpeedTier {
  id: string;
  name: string;
  description: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  speeds: SpeedTier[];
  defaultSpeed: string | null;
}

export function parseModel(value: unknown): ModelInfo | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id) ?? asString(value.model);
  if (!id) return null;
  const efforts = Array.isArray(value.supportedReasoningEfforts) ? value.supportedReasoningEfforts : [];
  const tiers = Array.isArray(value.serviceTiers) ? value.serviceTiers : [];
  return {
    id,
    displayName: asString(value.displayName) ?? id,
    description: asString(value.description) ?? '',
    isDefault: value.isDefault === true,
    reasoningEfforts: efforts
      .map((effort) => (isRecord(effort) ? asString(effort.reasoningEffort) : null))
      .filter((effort): effort is string => effort !== null),
    defaultReasoningEffort: asString(value.defaultReasoningEffort),
    speeds: tiers
      .filter(isRecord)
      .map((tier) => ({ id: asString(tier.id) ?? '', name: asString(tier.name) ?? '', description: asString(tier.description) ?? '' }))
      .filter((tier) => tier.id !== ''),
    defaultSpeed: asString(value.defaultServiceTier),
  };
}

const STANDARD_SPEED_ALIASES = new Set(['default', 'standard', 'normal']);

/**
 * Maps a caller's speed choice to an app-server service tier id. Accepts tier
 * ids ("priority"), display names ("Fast"), and "standard" for the default tier.
 */
export function resolveSpeed(model: ModelInfo | undefined, speed: string | undefined): string | undefined {
  if (speed === undefined) return undefined;
  const wanted = speed.trim().toLowerCase();
  if (STANDARD_SPEED_ALIASES.has(wanted)) return 'default';
  if (!model) return wanted === 'fast' ? 'priority' : speed.trim();
  const match = model.speeds.find((tier) => tier.id.toLowerCase() === wanted || tier.name.toLowerCase() === wanted);
  if (match) return match.id;
  if (wanted === 'fast') {
    const priority = model.speeds.find((tier) => tier.id === 'priority');
    if (priority) return priority.id;
  }
  const options = ['standard', ...model.speeds.map((tier) => `${tier.id} (${tier.name})`)].join(', ');
  throw new BridgeError(`Model ${model.id} does not support speed "${speed}". Available: ${options}.`);
}

export function validateEffort(model: ModelInfo | undefined, effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined;
  const wanted = effort.trim().toLowerCase();
  if (!model || model.reasoningEfforts.length === 0) return wanted;
  if (model.reasoningEfforts.includes(wanted)) return wanted;
  throw new BridgeError(
    `Model ${model.id} does not support reasoning effort "${effort}". Available: ${model.reasoningEfforts.join(', ')}.`,
  );
}

export function findModel(models: ModelInfo[], id: string | undefined | null): ModelInfo | undefined {
  if (!id) return undefined;
  const wanted = id.toLowerCase();
  return models.find((model) => model.id.toLowerCase() === wanted || model.displayName.toLowerCase() === wanted);
}

import { describe, expect, it } from 'vitest';
import { parseModel, resolveSpeed, validateEffort, type ModelInfo } from '../src/catalog.js';

const model = parseModel({
  id: 'gpt-test',
  displayName: 'GPT Test',
  isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
  defaultReasoningEffort: 'low',
  serviceTiers: [
    { id: 'priority', name: 'Fast', description: '' },
    { id: 'ultrafast', name: 'Ultrafast', description: '' },
  ],
}) as ModelInfo;

describe('model options', () => {
  it('parses app-server model entries', () => {
    expect(model).toMatchObject({ id: 'gpt-test', reasoningEfforts: ['low', 'high'], speeds: [{ id: 'priority' }, { id: 'ultrafast' }] });
  });

  it('maps speed names and ids to service tiers', () => {
    expect(resolveSpeed(model, 'fast')).toBe('priority');
    expect(resolveSpeed(model, 'Ultrafast')).toBe('ultrafast');
    expect(resolveSpeed(model, 'standard')).toBe('default');
    expect(resolveSpeed(undefined, 'fast')).toBe('priority');
    expect(resolveSpeed(model, undefined)).toBeUndefined();
    expect(() => resolveSpeed(model, 'warp')).toThrow(/priority \(Fast\)/);
  });

  it('rejects reasoning efforts the model does not support', () => {
    expect(validateEffort(model, 'HIGH')).toBe('high');
    expect(() => validateEffort(model, 'ultra')).toThrow(/Available: low, high/);
  });
});

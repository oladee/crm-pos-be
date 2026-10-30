jest.mock('@nestjs/mongoose', () => ({ InjectModel: () => () => undefined }));
jest.mock('@simplewebauthn/server', () => ({}));
jest.mock('@simplewebauthn/server/helpers', () => ({}));
import { PosPasskeyService } from './pos-passkey.service';

describe('location till numbering', () => {
  function setup(labels: string[], counter = 0) {
    const service: any = Object.create(PosPasskeyService.prototype);
    service.deviceModel = { find: jest.fn(() => ({ lean: async () => labels.map(label => ({ label })) })) };
    service.sequenceModel = { findOneAndUpdate: jest.fn(async (_filter, pipeline) => {
      counter = Math.max(counter, pipeline[0].$set.value.$add[0].$max[1]) + 1;
      return { value: counter };
    }) };
    return service;
  }
  it('starts at one for an empty location', async () => {
    expect(await setup([]).tillLabel('lagos', null)).toBe('Till 1');
  });
  it('uses the highest number, including gaps and legacy duplicates', async () => {
    const service = setup(['Till 1', 'Till 1', 'Till 7', 'Front desk']);
    expect(await service.tillLabel('lagos', null)).toBe('Till 8');
    expect(service.deviceModel.find).toHaveBeenCalledWith({ hub: 'lagos' });
  });
  it('keeps a higher reserved sequence', async () => {
    expect(await setup(['Till 2'], 9).tillLabel('lagos', null)).toBe('Till 10');
  });
  it('preserves the same device number when re-enrolled at its location', async () => {
    const service = setup(['Till 3']);
    expect(await service.tillLabel('lagos', { hub: 'lagos', label: 'Till 3' })).toBe('Till 3');
    expect(service.sequenceModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('allocates a new number when moving a revoked device to another location', async () => {
    expect(await setup(['Till 4']).tillLabel('lagos', { hub: 'abuja', label: 'Till 1' })).toBe('Till 5');
  });
});

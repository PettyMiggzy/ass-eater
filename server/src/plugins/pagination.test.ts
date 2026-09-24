import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { page } from './pagination';

describe('page()', () => {
  it('defaults and clamps', () => {
    expect(page({})).toEqual({ offset: 0, limit: 30 });
    expect(page(undefined)).toEqual({ offset: 0, limit: 30 });
    expect(page({ limit: '500' })).toEqual({ offset: 0, limit: 100 });
    expect(page({ limit: '20', offset: '40' }, { limit: 10, max: 50 })).toEqual({ offset: 40, limit: 20 });
    expect(page({}, { limit: 10, max: 50 })).toEqual({ offset: 0, limit: 10 });
  });
  it('turns junk into a ZodError (400), never NaN/negatives for Prisma (500)', () => {
    for (const q of [{ offset: 'abc' }, { offset: '-1' }, { limit: '-5' }, { limit: '0' }, { limit: '1.5' }, { offset: '99999999' }]) {
      expect(() => page(q)).toThrow(ZodError);
    }
  });
});

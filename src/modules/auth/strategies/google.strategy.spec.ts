import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Profile } from 'passport-google-oauth20';

jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));
jest.mock('@nestjs/passport', () => ({
  PassportStrategy: () =>
    class {
      constructor(..._args: unknown[]) {}
    },
}));

import { GoogleStrategy } from './google.strategy';

const profileWith = (emails: unknown): Profile =>
  ({ displayName: 'New User', emails }) as unknown as Profile;

describe('GoogleStrategy', () => {
  const config = {
    getOrThrow: jest.fn((key: string) => `value-for-${key}`),
    get: jest.fn(() => undefined),
  } as unknown as ConfigService;

  const strategy = new GoogleStrategy(config);
  const validate = (profile: Profile) => strategy.validate('at', 'rt', profile);

  it('reduces a Google profile to the fields the account logic needs', () => {
    expect(
      validate(profileWith([{ value: 'New@Acme.com', verified: true }])),
    ).toEqual({
      email: 'New@Acme.com',
      provider: 'google',
      displayName: 'New User',
    });
  });

  it('rejects an unverified email — accounts are matched by address', () => {
    // Without this, anyone who can register someone else's address with Google
    // could sign straight into that person's existing DocuShield account.
    expect(() =>
      validate(profileWith([{ value: 'victim@acme.com', verified: false }])),
    ).toThrow(UnauthorizedException);
  });

  it('rejects the string "false" too, since providers are inconsistent here', () => {
    expect(() =>
      validate(profileWith([{ value: 'victim@acme.com', verified: 'false' }])),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a profile with no email at all', () => {
    expect(() => validate(profileWith([]))).toThrow(UnauthorizedException);
    expect(() => validate(profileWith(undefined))).toThrow(UnauthorizedException);
  });
});

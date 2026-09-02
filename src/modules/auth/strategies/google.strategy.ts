import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy } from 'passport-google-oauth20';
import { OAuthProfile } from '../auth.types';

/**
 * Google sign-in (Part 1.6). Constructed only when credentials are present —
 * see AuthModule's factory — because passport-google-oauth20 throws on an empty
 * clientID and would take the whole app down with it.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    super({
      clientID: config.getOrThrow<string>('OAUTH_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('OAUTH_CLIENT_SECRET'),
      callbackURL:
        config.get<string>('OAUTH_CALLBACK_URL') ??
        'http://localhost:4000/auth/google/callback',
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): OAuthProfile {
    const email = profile.emails?.[0];
    if (!email?.value) {
      throw new UnauthorizedException('Google account has no email address');
    }
    // Accounts are matched to existing users by email, so an unverified address
    // would let anyone who can create it claim someone else's account.
    if (email.verified === false || String(email.verified) === 'false') {
      throw new UnauthorizedException('Google account email is not verified');
    }

    return {
      email: email.value,
      provider: 'google',
      displayName: profile.displayName,
    };
  }
}

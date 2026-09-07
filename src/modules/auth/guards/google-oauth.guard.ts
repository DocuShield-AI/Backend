import {
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';

/**
 * Wraps the google passport strategy so an unconfigured server answers with a
 * clear 503 instead of passport's "Unknown authentication strategy" 500.
 */
@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  constructor(private readonly config: ConfigService) {
    super();
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const configured =
      !!this.config.get<string>('OAUTH_CLIENT_ID') &&
      !!this.config.get<string>('OAUTH_CLIENT_SECRET');
    if (!configured) {
      throw new ServiceUnavailableException(
        'Google sign-in is not configured on this server',
      );
    }
    return super.canActivate(context);
  }

  /**
   * A `/auth/google?inviteCode=CODE` link carries the code through the OAuth
   * round-trip in the `state` parameter (Google echoes it back untouched). It
   * is not a CSRF token here — the flow has no session yet — so carrying
   * non-secret data in it is safe.
   */
  getAuthenticateOptions(context: ExecutionContext): { state?: string } {
    const req = context.switchToHttp().getRequest();
    const inviteCode = req.query?.inviteCode;
    const state =
      typeof inviteCode === 'string' && inviteCode.length > 0
        ? JSON.stringify({ inviteCode })
        : undefined;
    return { state };
  }
}

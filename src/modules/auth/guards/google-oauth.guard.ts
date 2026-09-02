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
}

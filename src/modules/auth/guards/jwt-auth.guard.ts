import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Global authentication gate (Part 1.6).
 *
 * Registered as an APP_GUARD so every route is protected by default; only
 * routes carrying @Public() are let through unauthenticated. Doing it this way
 * round means a new endpoint is closed until someone deliberately opens it,
 * rather than open until someone remembers to close it.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    // Handler first, then controller, so a class-level @Public can be narrowed
    // by an individual route and vice versa.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }
}

import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Opts a route out of the global JwtAuthGuard.
 *
 * Authentication is opt-out rather than opt-in on purpose: a route that someone
 * forgets to annotate ends up protected, which is the safe direction to fail.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

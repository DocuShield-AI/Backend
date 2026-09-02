import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { AuthenticatedUser } from '../auth.types';

/**
 * Exported separately from the decorator so it can be called directly in tests
 * — a param decorator's factory is otherwise only reachable through Nest's
 * route metadata.
 */
export const currentUserFactory = (
  field: keyof AuthenticatedUser | undefined,
  ctx: ExecutionContext,
): AuthenticatedUser | AuthenticatedUser[keyof AuthenticatedUser] | undefined => {
  const user = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
  return field ? user?.[field] : user;
};

/**
 * Reads the authenticated user that JwtStrategy attached to the request.
 *
 * `@CurrentUser('workspaceId')` returns just that field. This is what lets
 * controllers stop inventing their own workspace/user ids.
 */
export const CurrentUser = createParamDecorator(currentUserFactory);

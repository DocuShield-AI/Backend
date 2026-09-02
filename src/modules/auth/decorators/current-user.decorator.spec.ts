import { ExecutionContext } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth.types';
import { currentUserFactory } from './current-user.decorator';

const user: AuthenticatedUser = {
  userId: 'u_1',
  workspaceId: 'ws_1',
  role: Role.legal,
};

const ctxWith = (value?: AuthenticatedUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user: value }) }),
  }) as unknown as ExecutionContext;

describe('@CurrentUser', () => {
  it('returns the whole user when no field is named', () => {
    expect(currentUserFactory(undefined, ctxWith(user))).toEqual(user);
  });

  it('returns just the named field', () => {
    expect(currentUserFactory('workspaceId', ctxWith(user))).toBe('ws_1');
    expect(currentUserFactory('userId', ctxWith(user))).toBe('u_1');
    expect(currentUserFactory('role', ctxWith(user))).toBe(Role.legal);
  });

  it('is undefined rather than throwing on an unauthenticated request', () => {
    // A @Public route has no req.user; reading it must not crash the handler.
    expect(currentUserFactory(undefined, ctxWith(undefined))).toBeUndefined();
    expect(currentUserFactory('workspaceId', ctxWith(undefined))).toBeUndefined();
  });
});

import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Two-tier rate limiting (Part 4.1) keyed by tenant:
 * - IP for anonymous / unauthenticated traffic
 * - workspace id for known tenants
 *
 * The workspace id is currently read from the `x-workspace-id` header. When
 * Shanza's auth is wired up (JwtAuthGuard / RolesGuard), this should be
 * derived from the authenticated user's workspace instead — the header seam
 * is intentionally isolated here so only this method changes.
 */
@Injectable()
export class WorkspaceThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const workspaceId =
      req?.headers?.['x-workspace-id'] ?? req?.workspaceId;
    if (workspaceId) {
      return `workspace:${workspaceId}`;
    }
    return req?.ip ?? `${req?.headers?.['x-forwarded-for'] ?? 'unknown'}`;
  }
}

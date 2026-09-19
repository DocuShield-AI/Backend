import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Two-tier rate limiting: workspace id for authenticated callers (read from the
 * verified JWT), IP for anonymous traffic. Never trusts a client-supplied
 * workspace id header.
 */
@Injectable()
export class WorkspaceThrottlerGuard extends ThrottlerGuard {
  // `any` is required to match the base class signature exactly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const workspaceId = req?.user?.workspaceId;
    if (workspaceId) {
      return `workspace:${workspaceId}`;
    }
    return req?.ip ?? 'unknown';
  }
}
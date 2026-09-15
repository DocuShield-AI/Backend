import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';

const DB_CHECK_TIMEOUT_MS = 3000;

enum HealthStatus {
  Ok = 'ok',
  Degraded = 'degraded',
}

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  async check(): Promise<{ status: string; db: string; uptime: number; timestamp: number }> {
    const base = { uptime: process.uptime(), timestamp: Date.now() };
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('db check timed out')), DB_CHECK_TIMEOUT_MS),
        ),
      ]);
      return { status: HealthStatus.Ok, db: 'up', ...base };
    } catch {
      return { status: HealthStatus.Degraded, db: 'down', ...base };
    }
  }
}
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

const DEFAULT_PORT = 4000;

function readPort(): number {
  const raw = process.env.PORT;
  if (!raw) {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (Number.isInteger(port) && port > 0 && port < 65_536) {
    return port;
  }
  throw new Error(`Invalid PORT: ${raw}`);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Closing Prisma/BullMQ connections on SIGTERM prevents orphaned connections
  // and in-flight jobs marked as failed during deploys.
  app.enableShutdownHooks();
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.use(cookieParser());
  app.use(helmet());

  // The SPA reads its session from httpOnly cookies, so the browser must be
  // allowed to both send and receive cookies -> credentials: true. The origin
  // is pinned to the frontend instead of "*", because credentials + wildcard
  // origins are mutually exclusive by design.
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('DocuShield API')
    .setDescription('Contract ingestion and workspace management API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(readPort());
}

void bootstrap();
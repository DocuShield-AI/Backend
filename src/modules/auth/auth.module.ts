import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './controllers/auth.controller';
import { AuthService } from './services/auth.service';
import { PasswordService } from './services/password.service';
import { RefreshTokenStore } from './services/refresh-token.store';
import { JwtStrategy } from './strategies/jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';

/**
 * Auth domain — the entry point for the whole system (Part 1.6).
 *
 * Only the access token is registered here. Refresh tokens are signed with a
 * separate secret (JWT_REFRESH_SECRET) inside AuthService, so a leaked access
 * token can never be used to mint a new one.
 */
@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          // Env values are plain strings; the ms-style template literal type
          // cannot be proven statically, so the cast is the honest seam here.
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') ??
            '15m') as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    JwtStrategy,
    RefreshTokenStore,
    // Order matters: authentication must populate req.user before the role
    // check reads it. Nest runs global guards in registration order.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Built only when credentials exist. passport-google-oauth20 throws on an
    // empty clientID, so registering it unconditionally would stop the whole
    // API from booting on any machine that has not set up OAuth yet.
    {
      provide: GoogleStrategy,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const clientId = config.get<string>('OAUTH_CLIENT_ID');
        const clientSecret = config.get<string>('OAUTH_CLIENT_SECRET');
        if (!clientId || !clientSecret) {
          new Logger(AuthModule.name).warn(
            'OAUTH_CLIENT_ID/SECRET not set - /auth/google will answer 503',
          );
          return null;
        }
        return new GoogleStrategy(config);
      },
    },
  ],
  // PassportModule is re-exported so Phase 3's JwtAuthGuard can extend
  // AuthGuard('jwt') from anywhere without re-registering the strategy.
  exports: [AuthService, PassportModule],
})
export class AuthModule {}

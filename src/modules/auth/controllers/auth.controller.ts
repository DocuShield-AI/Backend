import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService, AuthResult, UserProfile } from '../services/auth.service';
import type { AuthenticatedUser, OAuthProfile } from '../auth.types';
import { TokenPair } from '../auth.types';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { GoogleOAuthGuard } from '../guards/google-oauth.guard';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshDto } from '../dto/refresh.dto';
import { SignupDto } from '../dto/signup.dto';

/**
 * The credential-guessing endpoints get their own, much tighter limit. The
 * global per-IP tier is 100/minute, which is fine for ordinary API traffic but
 * would allow a hundred password attempts a minute, forever.
 */
const CREDENTIAL_THROTTLE = { ip: { limit: 10, ttl: 60_000 } };

/**
 * @Public() is applied per route rather than to the controller, so that adding
 * an authenticated route here (like /auth/me) cannot accidentally inherit
 * "no token required" from the class.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('signup')
  @Throttle(CREDENTIAL_THROTTLE)
  signup(@Body() dto: SignupDto): Promise<AuthResult> {
    return this.authService.signup(dto);
  }

  // 200 rather than the default 201: logging in does not create a resource.
  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle(CREDENTIAL_THROTTLE)
  login(@Body() dto: LoginDto): Promise<AuthResult> {
    return this.authService.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.authService.refresh(dto.refreshToken);
  }

  // 204: the session is gone, there is nothing to return.
  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Body() dto: RefreshDto): Promise<void> {
    return this.authService.logout(dto.refreshToken);
  }

  /**
   * Who am I? The frontend holds a token across reloads but nothing else, so
   * this is how it recovers the signed-in user without a second store.
   */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): Promise<UserProfile> {
    return this.authService.profile(user.userId);
  }

  @Post('change-password')
  @HttpCode(200)
  @Throttle(CREDENTIAL_THROTTLE)
  changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TokenPair> {
    return this.authService.changePassword(user.userId, dto);
  }

  /** Kicks off the Google flow; passport issues the redirect. */
  @Public()
  @Get('google')
  @UseGuards(GoogleOAuthGuard)
  googleAuth(): void {
    // Intentionally empty — the guard redirects before this runs.
  }

  /**
   * Where Google sends the browser back. Tokens are handed over in the URL
   * fragment rather than the query string: fragments are never sent to a
   * server, so they stay out of access logs and Referer headers.
   */
  @Public()
  @Get('google/callback')
  @UseGuards(GoogleOAuthGuard)
  async googleCallback(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.authService.validateOAuthLogin(
      req.user as OAuthProfile,
    );
    const target =
      this.config.get<string>('OAUTH_SUCCESS_REDIRECT') ??
      'http://localhost:3000/auth/callback';
    const fragment = new URLSearchParams({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    }).toString();

    res.redirect(`${target}#${fragment}`);
  }
}

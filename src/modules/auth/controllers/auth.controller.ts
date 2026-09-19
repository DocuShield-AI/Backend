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
import type { CookieOptions, Request, Response } from 'express';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { GoogleOAuthGuard } from '../guards/google-oauth.guard';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '../auth.types';
import { parseDurationToSeconds } from '../../../common/utils/parse-duration';
import type {
  AuthenticatedUser,
  OAuthProfile,
  TokenPair,
} from '../auth.types';
import { AuthService, AuthResult } from '../services/auth.service';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshDto } from '../dto/refresh.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import { SignupDto } from '../dto/signup.dto';
import { ResendSignupCodeDto } from '../dto/resend-signup-code.dto';
import { VerifyResetCodeDto } from '../dto/verify-reset-code.dto';
import { VerifySignupDto } from '../dto/verify-signup.dto';

/**
 * Public auth surface. Every route here authenticates by its own means, so
 * needing a token to log in would be circular — hence @Public() per route.
 * GET /auth/me deliberately stays protected: the browser asks "who am I?"
 * through the httpOnly cookie it cannot read itself.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  /** Express `maxAge` is milliseconds; JWT env values are parsed as seconds. */
  private sessionCookieOptions(maxAgeSeconds: number): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get<string>('NODE_ENV') === 'production',
      path: '/',
      maxAge: maxAgeSeconds * 1000,
    };
  }

  // httpOnly cookies keep tokens out of XSS's reach; max-ages mirror the JWT
  // lifetimes so the browser aligns with the real expiry.
  private setSessionCookies(res: Response, pair: TokenPair): void {
    res.cookie(
      ACCESS_TOKEN_COOKIE,
      pair.accessToken,
      this.sessionCookieOptions(this.envSeconds('JWT_EXPIRES_IN', '15m')),
    );
    res.cookie(
      REFRESH_TOKEN_COOKIE,
      pair.refreshToken,
      this.sessionCookieOptions(this.envSeconds('JWT_REFRESH_EXPIRES_IN', '7d')),
    );
  }

  private clearSessionCookies(res: Response): void {
    // clearCookie only matches if path (and other attrs) mirror the original.
    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });
  }

  // Cookie max-age mirrors the JWT lifetime; the token's own exp enforces expiry.
  private envSeconds(key: string, fallback: string): number {
    const raw = this.config.get<string>(key) ?? fallback;
    const seconds = parseDurationToSeconds(raw);
    return Number.isFinite(seconds) ? Math.max(1, Math.floor(seconds)) : 900;
  }

  @Public()
  @Post('signup')
  @HttpCode(200)
  async signup(
    @Body() dto: SignupDto,
  ): Promise<{ message: string; email: string; requiresVerification: true }> {
    return this.authService.signup(dto);
  }

  @Public()
  @Post('verify-signup')
  @HttpCode(200)
  async verifySignup(
    @Body() dto: VerifySignupDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthResult['user'] }> {
    const result = await this.authService.verifySignup(dto.email, dto.code);
    this.setSessionCookies(res, result);
    return { user: result.user };
  }

  @Public()
  @Post('resend-signup-code')
  @HttpCode(200)
  async resendSignupCode(
    @Body() dto: ResendSignupCodeDto,
  ): Promise<{ message: string }> {
    return this.authService.resendSignupCode(dto.email);
  }

  // Tighter per-IP cap on the credential route to slow brute force. 200 rather
  // than the default 201: logging in does not create a resource.
  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({ ip: { ttl: 60_000, limit: 10 } })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthResult['user'] }> {
    const result = await this.authService.login(dto);
    this.setSessionCookies(res, result);
    return { user: result.user };
  }

  // Cookie first, body fallback keeps scripted clients working.
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Body() dto: RefreshDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const presented: string =
      dto.refreshToken ?? req.cookies?.[REFRESH_TOKEN_COOKIE] ?? '';
    const pair = await this.authService.refresh(presented);
    this.setSessionCookies(res, pair);
  }

  // 204: the session is gone, there is nothing to return.
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Body() dto: RefreshDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const presented: string =
      dto.refreshToken ?? req.cookies?.[REFRESH_TOKEN_COOKIE] ?? '';
    await this.authService.logout(presented);
    this.clearSessionCookies(res);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<{ message: string }> {
    return this.authService.requestPasswordReset(dto.email);
  }

  @Public()
  @Post('verify-reset-code')
  @HttpCode(200)
  async verifyResetCode(
    @Body() dto: VerifyResetCodeDto,
  ): Promise<{ valid: true }> {
    return this.authService.verifyResetCode(dto.email, dto.code);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
  ): Promise<{ message: string }> {
    return this.authService.resetPassword(dto.email, dto.code, dto.password);
  }

  // Who am I? Reads the user off the access-token cookie; the SPA calls this on
  // boot because httpOnly cookies are the one thing JS cannot see.
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): { user: AuthenticatedUser } {
    return { user };
  }

  /** Kicks off the Google flow; passport issues the redirect. */
  @Public()
  @Get('google')
  @UseGuards(GoogleOAuthGuard)
  googleAuth(): void {
    // Intentionally empty — the guard redirects before this runs.
  }

  // Writes the new token pair into cookies and sends the browser to the SPA,
  // whose /auth/callback page simply records that a session now exists.
  @Public()
  @Get('google/callback')
  @UseGuards(GoogleOAuthGuard)
  async googleCallback(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.authService.validateOAuthLogin(
      req.user as OAuthProfile,
      parseOAuthState(req.query?.state)?.inviteCode,
    );
    const target =
      this.config.get<string>('OAUTH_SUCCESS_REDIRECT') ??
      'http://localhost:3000/auth/callback';
    this.setSessionCookies(res, result);
    res.redirect(target);
  }
}

/** Stashes inviteCode in Google's OAuth `state`; broken state means "no invite". */
function parseOAuthState(state: unknown): { inviteCode?: string } {
  if (typeof state !== 'string' || state.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(state) as { inviteCode?: unknown };
    return typeof parsed.inviteCode === 'string' && parsed.inviteCode.length > 0
      ? { inviteCode: parsed.inviteCode }
      : {};
  } catch {
    return {};
  }
}
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
import type { Request, Response } from 'express';
import type { OAuthProfile } from '../auth.types';
import { GoogleOAuthGuard } from '../guards/google-oauth.guard';
import { Public } from '../decorators/public.decorator';
import { AuthService, AuthResult } from '../services/auth.service';
import { TokenPair } from '../auth.types';
import { LoginDto } from '../dto/login.dto';
import { RefreshDto } from '../dto/refresh.dto';
import { SignupDto } from '../dto/signup.dto';

/**
 * Public auth surface. @Public() sits on the controller because every route
 * here authenticates by its own means — requiring a token to log in would be
 * circular.
 */
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('signup')
  signup(@Body() dto: SignupDto): Promise<AuthResult> {
    return this.authService.signup(dto);
  }

  // 200 rather than the default 201: logging in does not create a resource.
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto): Promise<AuthResult> {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.authService.refresh(dto.refreshToken);
  }

  // 204: the session is gone, there is nothing to return.
  @Post('logout')
  @HttpCode(204)
  logout(@Body() dto: RefreshDto): Promise<void> {
    return this.authService.logout(dto.refreshToken);
  }

  /** Kicks off the Google flow; passport issues the redirect. */
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

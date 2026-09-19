import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type Transporter from 'nodemailer/lib/mailer';
import { PASSWORD_RESET_TTL_SECONDS } from '../auth/services/password-reset.store';
import { SIGNUP_VERIFICATION_TTL_SECONDS } from '../auth/services/signup-verification.store';
import { buildPasswordResetEmail } from './templates/password-reset-email.template';
import { buildSignupVerificationEmail } from './templates/signup-verification-email.template';
import { buildWorkspaceInviteEmail } from './templates/workspace-invite-email.template';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    const host = this.config.get<string>('SMTP_HOST');
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');
    return Boolean(host && user && pass);
  }

  async sendPasswordResetCode(to: string, code: string): Promise<void> {
    const frontendUrl =
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
    const resetUrl = `${frontendUrl.replace(/\/$/, '')}/reset-password?email=${encodeURIComponent(to)}`;
    const expiryMinutes = Math.floor(PASSWORD_RESET_TTL_SECONDS / 60);

    const { subject, html, text } = buildPasswordResetEmail({
      code,
      resetUrl,
      expiryMinutes,
    });

    if (!this.isConfigured()) {
      this.logger.warn(
        `SMTP not configured — password reset code for ${to}: ${code} (reset: ${resetUrl})`,
      );
      return;
    }

    const from =
      this.config.get<string>('SMTP_FROM') ??
      'DocuShield <noreply@docushield.com>';

    await this.getTransporter().sendMail({
      from,
      to,
      subject,
      html,
      text,
    });

    this.logger.log(`Password reset email sent to ${to}`);
  }

  async sendSignupVerificationCode(to: string, code: string): Promise<void> {
    const frontendUrl =
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
    const verifyUrl = `${frontendUrl.replace(/\/$/, '')}/verify-email?email=${encodeURIComponent(to)}`;
    const expiryMinutes = Math.floor(SIGNUP_VERIFICATION_TTL_SECONDS / 60);

    const { subject, html, text } = buildSignupVerificationEmail({
      code,
      verifyUrl,
      expiryMinutes,
    });

    if (!this.isConfigured()) {
      this.logger.warn(
        `SMTP not configured — signup verification code for ${to}: ${code} (verify: ${verifyUrl})`,
      );
      return;
    }

    await this.getTransporter().sendMail({
      from:
        this.config.get<string>('SMTP_FROM') ??
        'DocuShield <noreply@docushield.com>',
      to,
      subject,
      html,
      text,
    });

    this.logger.log(`Signup verification email sent to ${to}`);
  }

  async sendWorkspaceInvite(args: {
    to: string;
    workspaceName: string;
    inviteCode: string;
    role: string;
    expiresAt: Date;
    inviterEmail?: string;
  }): Promise<void> {
    const frontendUrl =
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
    const joinUrl = `${frontendUrl.replace(/\/$/, '')}/register?mode=join&inviteCode=${encodeURIComponent(args.inviteCode)}`;

    const { subject, html, text } = buildWorkspaceInviteEmail({
      workspaceName: args.workspaceName,
      inviteCode: args.inviteCode,
      role: args.role,
      joinUrl,
      expiresAt: args.expiresAt,
      inviterEmail: args.inviterEmail,
    });

    if (!this.isConfigured()) {
      this.logger.warn(
        `SMTP not configured — workspace invite for ${args.to}: code ${args.inviteCode} (join: ${joinUrl})`,
      );
      return;
    }

    await this.getTransporter().sendMail({
      from:
        this.config.get<string>('SMTP_FROM') ??
        'DocuShield <noreply@docushield.com>',
      to: args.to,
      subject,
      html,
      text,
    });

    this.logger.log(`Workspace invite email sent to ${args.to}`);
  }

  private getTransporter(): Transporter {
    if (this.transporter) {
      return this.transporter;
    }

    const host = this.config.getOrThrow<string>('SMTP_HOST');
    const port = Number(this.config.get<string>('SMTP_PORT') ?? '587');
    const secure = this.config.get<string>('SMTP_SECURE') === 'true';

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user: this.config.getOrThrow<string>('SMTP_USER'),
        pass: this.config.getOrThrow<string>('SMTP_PASS'),
      },
    });

    return this.transporter;
  }
}

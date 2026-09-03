import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { AppError } from '../common/errors';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/auth.dto';
import { Public } from './permissions.decorator';
import { IssuedTokens, TokenService } from './token.service';

const REFRESH_COOKIE = 'refresh_token';
const ACCESS_COOKIE = 'access_token';

@ApiTags('Auth')
@Controller('admin/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Open only while the platform has no organisation owner or admin: that first ' +
      'registration bootstraps the platform and is signed in immediately. Once an ' +
      'administrator exists, this endpoint requires a signed-in owner or admin, and the ' +
      'created account is *not* signed in — the caller keeps their own session. A ' +
      'verification email is sent either way; the account works before verification, but ' +
      'publishing and inviting require a verified address.',
  })
  @ApiResponse({ status: 201, description: 'Account created.' })
  @ApiResponse({ status: 401, description: 'Registration is closed and no session was supplied.' })
  @ApiResponse({ status: 403, description: 'The caller is not an organisation owner or admin.' })
  @ApiResponse({ status: 409, description: 'An account with this email already exists.' })
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Public so an unauthenticated bootstrap can reach the handler; the actual
    // rule is in AuthService, which needs the database to know whether the
    // platform still has no administrator.
    const actor = req.ctx ? { userId: req.ctx.userId } : null;
    const { user, tokens } = await this.auth.register(dto, client(req), actor);
    if (tokens) this.setCookies(res, tokens);
    return { data: user };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Rate limited to 5 attempts per email and 20 per IP address per 15 minutes, with ' +
      'exponential lockout beyond that. Returns 401 `mfa_required` when the account has ' +
      'TOTP enabled and no code was supplied.',
  })
  @ApiResponse({ status: 200, description: 'Signed in.' })
  @ApiResponse({ status: 401, description: 'Incorrect credentials, or an MFA code is required.' })
  @ApiResponse({ status: 429, description: 'Too many attempts.' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, tokens } = await this.auth.login(dto, client(req));
    this.setCookies(res, tokens);
    return { data: user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rotate the session tokens',
    description:
      'Exchanges the refresh cookie for a new pair. The old refresh token is invalidated ' +
      'immediately; presenting it again revokes every session from that sign-in, on the ' +
      'assumption the token was stolen.',
  })
  @ApiResponse({ status: 401, description: 'The refresh token is invalid, expired, or reused.' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req as unknown as { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE];
    if (!token) {
      throw new AppError('session_expired', 'No session to refresh.');
    }
    const tokens = await this.auth.refresh(token, client(req));
    this.setCookies(res, tokens);
    return { data: { expires_in: tokens.expiresIn } };
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out of the current session' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req as unknown as { cookies?: Record<string, string> }).cookies?.[ACCESS_COOKIE];
    if (token) {
      const claims = await this.tokens.verifyAccessToken(token).catch(() => null);
      if (claims) await this.auth.logout(claims.sid);
    }
    this.clearCookies(res);
  }

  @Get('me')
  @ApiOperation({
    summary: 'The signed-in user, their organisations, and every site they can reach',
    description:
      'The single call the admin portal makes on boot. Workspaces include those reachable ' +
      'only through an org Owner/Admin role, which have no stored membership row.',
  })
  async me(@Req() req: Request) {
    return { data: await this.auth.me(req.ctx!.userId) };
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List active sessions for the signed-in user' })
  async sessions(@Req() req: Request) {
    const token = (req as unknown as { cookies?: Record<string, string> }).cookies?.[ACCESS_COOKIE];
    const claims = token ? await this.tokens.verifyAccessToken(token).catch(() => null) : null;
    return { data: await this.auth.listSessions(req.ctx!.userId, claims?.sid ?? '') };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke one session',
    description: 'Takes effect within seconds — session revocation is checked on every request.',
  })
  async revokeSession(@Param('id') id: string, @Req() req: Request) {
    const sessions = await this.auth.listSessions(req.ctx!.userId, '');
    if (!sessions.some((s) => s.id === id)) {
      throw new AppError('resource_not_found', 'Session not found.');
    }
    await this.tokens.revokeSession(id, 'revoked_by_user');
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Request a password reset link',
    description:
      'Always returns 202, whether or not the address has an account — reporting otherwise ' +
      'would turn this endpoint into an account-enumeration oracle.',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.auth.forgotPassword(dto.email, client(req));
    return { data: { sent: true } };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set a new password using a reset token',
    description: 'Single use, 30-minute expiry. Succeeding revokes every other session.',
  })
  @ApiResponse({ status: 400, description: 'The token is expired, already used, or unknown.' })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.auth.resetPassword(dto.token, dto.password, client(req));
    return { data: { reset: true } };
  }

  @Post('change-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change password for the logged-in user' })
  @ApiResponse({ status: 200, description: 'Password changed successfully.' })
  @ApiResponse({ status: 401, description: 'Incorrect current password or not signed in.' })
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request) {
    if (!req.ctx?.userId) {
      throw new AppError('invalid_credentials', 'You must be signed in to change your password.');
    }
    await this.auth.changePassword(req.ctx.userId, dto.current_password, dto.new_password, client(req));
    return { data: { success: true } };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm an email address' })
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.auth.verifyEmail(dto.token);
    return { data: { verified: true } };
  }

  // -------------------------------------------------------------------------

  private setCookies(res: Response, tokens: IssuedTokens): void {
    const secure = this.config.get('COOKIE_SECURE') !== 'false';
    const base = {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      domain: this.config.get<string>('COOKIE_DOMAIN') || undefined,
      path: '/',
    };

    res.cookie(ACCESS_COOKIE, tokens.accessToken, {
      ...base,
      maxAge: tokens.expiresIn * 1000,
    });

    // The refresh cookie is restricted to the refresh endpoint, so it is not
    // sent with — and cannot be stolen from — any other request.
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...base,
      path: '/admin/v1/auth/refresh',
      maxAge: Number(this.config.get('REFRESH_TOKEN_TTL_DAYS') ?? 30) * 86_400_000,
    });
  }

  private clearCookies(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/admin/v1/auth/refresh' });
  }
}

function client(req: Request) {
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    requestId: req.requestId,
  };
}

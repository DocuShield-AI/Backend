import { IsJWT, IsOptional } from 'class-validator';

/**
 * The refresh token normally travels in an httpOnly cookie, so the body field
 * is optional — the controller reads the cookie first and only falls back to
 * this for scripted clients (curl, Postman, tests).
 */
export class RefreshDto {
  @IsOptional()
  @IsJWT()
  refreshToken?: string;
}
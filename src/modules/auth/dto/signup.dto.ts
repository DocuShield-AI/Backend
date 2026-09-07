import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export type SignupType = 'create' | 'join';

export class SignupDto {
  @IsEmail()
  email: string;

  /**
   * bcrypt silently truncates anything past 72 bytes, so the cap is enforced
   * here rather than letting two different long passwords hash identically.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  /**
   * create → a new workspace is made and this user becomes its admin (default,
   * kept for backwards compatibility with existing clients).
   * join   → user is added to an existing workspace via inviteCode.
   */
  @IsOptional()
  @IsIn(['create', 'join'])
  type?: SignupType;

  /**
   * Only required for `type: 'create'`. The first account in a workspace
   * becomes its admin, which is what gives RBAC something to check.
   */
  @ValidateIf((o: SignupDto) => (o.type ?? 'create') === 'create')
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  workspaceName?: string;

  /**
   * Only required for `type: 'join'`. Consumed (single-use) when the user is
   * added to the workspace with the role baked into the invite.
   */
  @ValidateIf((o: SignupDto) => o.type === 'join')
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  inviteCode?: string;
}
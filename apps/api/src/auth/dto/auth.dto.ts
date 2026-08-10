import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'priya@acme.com', description: 'Must be unique across the platform.' })
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email!: string;

  @ApiProperty({
    example: 'correct horse battery staple',
    minLength: 12,
    description:
      'At least 12 characters. Checked against known breach corpora via k-anonymity — ' +
      'the password itself never leaves the server.',
  })
  @IsString()
  @MinLength(12, { message: 'Use at least 12 characters.' })
  @MaxLength(256)
  password!: string;

  @ApiPropertyOptional({ example: 'Priya Raman' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  full_name?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'priya@acme.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'correct horse battery staple' })
  @IsString()
  password!: string;

  @ApiPropertyOptional({
    example: '123456',
    description: 'Required only when the account has TOTP MFA enabled.',
  })
  @IsOptional()
  @IsString()
  mfa_code?: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'priya@acme.com' })
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'The single-use token from the reset email.' })
  @IsString()
  token!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(256)
  password!: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'The single-use token from the verification email.' })
  @IsString()
  token!: string;
}

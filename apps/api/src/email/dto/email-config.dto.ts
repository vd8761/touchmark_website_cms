import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateEmailConfigurationDto {
  @ApiProperty({
    example: 'Acme — production',
    description: 'How this configuration appears in the site-level dropdown.',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    example: 're_xxxxxxxxxxxxxxxxxxxxxxxx',
    description:
      'A Resend API key. Validated against Resend before the configuration is saved, ' +
      'encrypted at rest, and never returned by any endpoint.',
  })
  @IsString()
  @MinLength(10)
  api_key!: string;

  @ApiPropertyOptional({ enum: ['resend'], default: 'resend' })
  @IsOptional()
  @IsIn(['resend'])
  provider?: 'resend';
}

export class UpdateEmailConfigurationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({
    description: 'Supply only when rotating the key. Revalidated before it replaces the old one.',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  api_key?: string;

  @ApiPropertyOptional({ description: 'Disabled configurations refuse to send.' })
  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

export class SelectEmailConfigurationDto {
  @ApiProperty({
    description:
      'An email configuration belonging to this site’s organisation. Null detaches the site, ' +
      'which stops it sending.',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  email_configuration_id!: string | null;
}

export class CreateSenderIdentityDto {
  @ApiProperty({ example: 'Acme Newsletter' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  from_name!: string;

  @ApiProperty({
    example: 'news@acme.com',
    description:
      'Must be on a domain verified in the site’s selected email configuration — the platform ' +
      'checks this against Resend rather than taking your word for it.',
  })
  @IsEmail()
  from_email!: string;

  @ApiPropertyOptional({ example: 'hello@acme.com' })
  @IsOptional()
  @IsEmail()
  reply_to_email?: string;

  @ApiPropertyOptional({
    description: 'Make this the site’s preferred from-address.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}

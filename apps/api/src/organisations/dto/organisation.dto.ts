import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ORG_ROLES, WORKSPACE_ROLES, type OrgRole, type WorkspaceRole } from '@cms/shared';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateOrganisationDto {
  @ApiProperty({ example: 'Acme Inc' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({
    example: 'acme',
    description: 'Lowercase, hyphen-separated. Derived from the name when omitted.',
  })
  @IsOptional()
  @Matches(SLUG_PATTERN, { message: 'Use lowercase letters, numbers and hyphens only.' })
  @MaxLength(60)
  slug?: string;
}

export class UpdateOrganisationDto {
  @ApiPropertyOptional({ example: 'Acme Inc' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: 'https://cdn.acme.com/logo.png' })
  @IsOptional()
  @IsString()
  logo_url?: string;

  @ApiPropertyOptional({ example: 'billing@acme.com' })
  @IsOptional()
  @IsEmail()
  billing_email?: string;
}

export class WorkspaceGrantDto {
  @ApiProperty({ description: 'Workspace id to grant access to.' })
  @IsUUID()
  workspace_id!: string;

  @ApiProperty({ enum: WORKSPACE_ROLES })
  @IsIn(WORKSPACE_ROLES)
  role!: WorkspaceRole;
}

export class InviteMemberDto {
  @ApiProperty({ example: 'dev@acme.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ enum: ORG_ROLES, default: 'member' })
  @IsIn(ORG_ROLES)
  org_role!: OrgRole;

  @ApiPropertyOptional({
    type: [WorkspaceGrantDto],
    description:
      'Per-site roles applied when the invitation is accepted. An org role of `member` with ' +
      'no grants creates a member who can see nothing — usually not what you want.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WorkspaceGrantDto)
  workspace_grants?: WorkspaceGrantDto[];
}

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: ORG_ROLES })
  @IsIn(ORG_ROLES)
  role!: OrgRole;
}

export class TransferOwnershipDto {
  @ApiProperty({ description: 'The user id of the member who becomes Owner.' })
  @IsUUID()
  user_id!: string;
}

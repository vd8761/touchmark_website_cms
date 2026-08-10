import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import type { OrgPermission, Permission } from '@cms/shared';

export const REQUIRED_PERMISSION = 'required_permission';
export const REQUIRED_ORG_PERMISSION = 'required_org_permission';
export const IS_PUBLIC = 'is_public';

/**
 * Declares the workspace permission a route needs.
 *
 * One decorator drives two things: PermissionsGuard reads the metadata to call
 * authorize(), and the same value is emitted into the OpenAPI document as
 * `x-required-permission` (§15.2 item 8). Deriving the documentation from the
 * enforcement means the docs cannot drift from the behaviour.
 */
export const RequirePermission = (permission: Permission) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSION, permission),
    ApiExtension('x-required-permission', permission),
  );

export const RequireOrgPermission = (permission: OrgPermission) =>
  applyDecorators(
    SetMetadata(REQUIRED_ORG_PERMISSION, permission),
    ApiExtension('x-required-org-permission', permission),
  );

/** Opts a route out of authentication entirely — login, register, health. */
export const Public = () =>
  applyDecorators(SetMetadata(IS_PUBLIC, true), ApiExtension('x-public', true));

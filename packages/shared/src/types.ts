/**
 * Wire types shared between the API and the admin portal.
 *
 * Field naming is snake_case (Appendix B: "API fields — snake_case"), which is
 * why these do not simply mirror the Prisma models.
 */

import type { OrgRole, Permission, WorkspaceRole } from './permissions';

export interface ResponseMeta {
  request_id: string;
  total?: number;
  limit?: number;
  has_more?: boolean;
  next_cursor?: string | null;
  schema_version?: number;
}

export interface SingleResponse<T> {
  data: T;
  meta: ResponseMeta;
}

export interface CollectionResponse<T> {
  data: T[];
  meta: ResponseMeta;
}

export interface UserDto {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  timezone: string;
  locale: string;
  mfa_enabled: boolean;
  email_verified: boolean;
  status: 'active' | 'suspended' | 'deleted';
  created_at: string;
}

export interface OrganisationDto {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  plan: 'free' | 'starter' | 'growth' | 'enterprise';
  status: 'active' | 'past_due' | 'suspended';
  role: OrgRole;
  created_at: string;
}

export interface WorkspaceDto {
  id: string;
  organisation_id: string;
  name: string;
  slug: string;
  description: string | null;
  icon_url: string | null;
  colour: string;
  primary_url: string | null;
  timezone: string;
  default_locale: string;
  locales: string[];
  status: 'active' | 'archived';
  role: WorkspaceRole | null;
  /**
   * The one person accountable for this site. Always holds Site Admin, cannot be
   * demoted or removed from the members list, and is transferred rather than
   * edited. Null only for sites created before ownership was recorded.
   */
  owner_id: string | null;
  created_at: string;
}

export interface WorkspaceMemberDto {
  id: string;
  user: Pick<UserDto, 'id' | 'email' | 'full_name' | 'avatar_url'>;
  role: WorkspaceRole;
  /** True when the role is inherited from an org Owner/Admin rather than stored (§3.3). */
  inherited: boolean;
  /** The site owner. Always Site Admin; cannot be demoted or removed, only transferred. */
  is_owner: boolean;
  added_at: string;
}

export interface OrganisationMemberDto {
  id: string;
  user: Pick<UserDto, 'id' | 'email' | 'full_name' | 'avatar_url'>;
  role: OrgRole;
  status: 'active' | 'invited';
  joined_at: string | null;
  last_active_at: string | null;
  workspaces: { id: string; name: string; role: WorkspaceRole }[];
}

export interface InvitationDto {
  id: string;
  email: string;
  org_role: OrgRole;
  workspace_grants: { workspace_id: string; role: WorkspaceRole }[];
  expires_at: string;
  accepted_at: string | null;
  invited_by: Pick<UserDto, 'id' | 'full_name'> | null;
  created_at: string;
}

export interface SessionDto {
  id: string;
  user_agent: string | null;
  ip: string | null;
  current: boolean;
  created_at: string;
  expires_at: string;
}

/** `GET /admin/v1/auth/me` — everything the portal shell needs on boot. */
export interface MeResponse {
  user: UserDto;
  organisations: OrganisationDto[];
  workspaces: WorkspaceDto[];
}

/** The resolved request context of §3.4 layer 1. */
export interface RequestContext {
  user_id: string;
  org_id: string | null;
  workspace_id: string | null;
  org_role: OrgRole | null;
  effective_role: WorkspaceRole | null;
  permissions: Permission[];
}

export interface AuthTokens {
  access_token: string;
  expires_in: number;
}

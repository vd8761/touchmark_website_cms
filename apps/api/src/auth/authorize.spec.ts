import {
  permissionsForWorkspaceRole,
  readOnlyPermissions,
  type Permission,
  type WorkspaceRole,
} from '@cms/shared';

import { AppError } from '../common/errors';
import { RequestContext } from '../common/request-context';
import { authorize, can } from './authorize';

function contextFor(
  role: WorkspaceRole | null,
  userId = 'user-1',
  archived = false,
): RequestContext {
  const granted = role ? permissionsForWorkspaceRole(role) : [];
  return new RequestContext(
    'req_test',
    userId,
    'org-1',
    'ws-1',
    'member',
    role,
    // The same reduction RequestContextGuard applies, from the same function.
    new Set(archived ? readOnlyPermissions(granted) : granted),
    null,
    null,
    archived,
  );
}

describe('authorize', () => {
  it('allows an action the role holds directly', () => {
    expect(() => authorize(contextFor('editor'), 'content.publish')).not.toThrow();
  });

  it('denies an action the role does not hold', () => {
    expect(() => authorize(contextFor('editor'), 'apikey.manage')).toThrow(AppError);
  });

  it('fails closed with no context at all', () => {
    expect(() => authorize(undefined, 'content.view')).toThrow(AppError);
  });

  it('fails closed for a user with no role in the workspace', () => {
    expect(() => authorize(contextFor(null), 'content.view')).toThrow(AppError);
  });

  describe('ownership-scoped permissions', () => {
    it('lets an Author edit their own entry', () => {
      const ctx = contextFor('author', 'author-1');
      expect(() => authorize(ctx, 'content.edit', { ownerId: 'author-1' })).not.toThrow();
    });

    it("refuses an Author editing someone else's entry", () => {
      const ctx = contextFor('author', 'author-1');
      expect(() => authorize(ctx, 'content.edit', { ownerId: 'author-2' })).toThrow(AppError);
    });

    it('refuses when no resource is supplied to compare ownership against', () => {
      // A missing resource is a programming error, not a grant. Treating it as
      // a grant would turn every un-instrumented call site into a hole.
      const ctx = contextFor('author', 'author-1');
      expect(() => authorize(ctx, 'content.edit')).toThrow(AppError);
    });

    it('lets an Author delete their own draft but not their own published entry', () => {
      const ctx = contextFor('author', 'author-1');
      expect(() =>
        authorize(ctx, 'content.delete', { ownerId: 'author-1', status: 'draft' }),
      ).not.toThrow();
      expect(() =>
        authorize(ctx, 'content.delete', { ownerId: 'author-1', status: 'published' }),
      ).toThrow(AppError);
    });

    it('lets an Editor edit anyone’s entry — the ownership check does not apply', () => {
      const ctx = contextFor('editor', 'editor-1');
      expect(() => authorize(ctx, 'content.edit', { ownerId: 'someone-else' })).not.toThrow();
    });
  });

  describe('the §3.3 matrix, end to end', () => {
    const cases: [WorkspaceRole, Permission, boolean][] = [
      ['site_admin', 'apikey.manage', true],
      ['site_admin', 'contenttype.manage', true],
      ['editor', 'contenttype.manage', false],
      ['editor', 'senderidentity.manage', false],
      ['editor', 'campaign.send', true],
      ['author', 'content.publish', false],
      ['author', 'media.upload', true],
      ['author', 'subscriber.manage', false],
      ['marketer', 'campaign.send', true],
      ['marketer', 'content.create', false],
      ['marketer', 'apikey.manage', false],
      ['analyst', 'analytics.view', true],
      ['analyst', 'media.upload', false],
      ['analyst', 'content.create', false],
    ];

    it.each(cases)('%s %s → %s', (role, permission, expected) => {
      expect(can(contextFor(role), permission)).toBe(expected);
    });
  });

  describe('archived sites', () => {
    it('reports the archive as the reason, not the user’s role', () => {
      // A Site Admin denied a write on an archived site must not be told to ask
      // a Site Admin for a better role — they already are one, and the role is
      // not the problem.
      try {
        authorize(contextFor('site_admin', 'admin-1', true), 'workspace.settings.edit');
        fail('expected a denial');
      } catch (error) {
        expect((error as AppError).code).toBe('workspace_archived');
        expect((error as AppError).detail).toContain('archived');
      }
    });

    it('still allows reads on an archived site', () => {
      expect(() => authorize(contextFor('editor', 'e-1', true), 'content.view')).not.toThrow();
    });
  });

  it('reports which permission was needed, so the UI can say so', () => {
    try {
      authorize(contextFor('analyst'), 'content.publish');
      fail('expected a denial');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('insufficient_permission');
      expect((error as AppError).detail).toContain('content.publish');
    }
  });
});

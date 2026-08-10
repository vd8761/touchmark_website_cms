import test from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveWorkspaceRole,
  permissionsForOrgRole,
  permissionsForWorkspaceRole,
  WORKSPACE_ROLES,
  // Explicit .ts extensions: this file runs under `node --test` with type
  // stripping, which does not resolve extensionless specifiers.
} from './permissions.ts';
import { decodePublicId, encodePublicId, isPublicId } from './ids.ts';

// --- The §3.3 matrix, spot-checked at the rows that are easy to get wrong ----

test('only site_admin and editor may publish', () => {
  const canPublish = WORKSPACE_ROLES.filter((r) =>
    permissionsForWorkspaceRole(r).includes('content.publish'),
  );
  assert.deepEqual(canPublish, ['site_admin', 'editor']);
});

test('only site_admin manages keys, sender identities and webhooks', () => {
  for (const permission of ['apikey.manage', 'senderidentity.manage', 'webhook.manage'] as const) {
    const holders = WORKSPACE_ROLES.filter((r) =>
      permissionsForWorkspaceRole(r).includes(permission),
    );
    assert.deepEqual(holders, ['site_admin'], `${permission} escaped site_admin`);
  }
});

test('marketer can send campaigns but cannot touch content', () => {
  const marketer = permissionsForWorkspaceRole('marketer');
  assert.ok(marketer.includes('campaign.send'));
  assert.ok(marketer.includes('content.view'));
  assert.ok(!marketer.includes('content.create'));
  assert.ok(!marketer.includes('content.edit'));
});

test('analyst has no write permission anywhere', () => {
  const writeVerbs = ['create', 'edit', 'delete', 'manage', 'publish', 'send', 'upload', 'approve'];
  for (const permission of permissionsForWorkspaceRole('analyst')) {
    const isWrite = writeVerbs.some((verb) => permission.includes(verb));
    assert.ok(!isWrite, `analyst holds write permission ${permission}`);
  }
});

test('author gets only the ownership-scoped edit and delete', () => {
  const author = permissionsForWorkspaceRole('author');
  assert.ok(author.includes('content.edit.own'));
  assert.ok(!author.includes('content.edit'));
  assert.ok(author.includes('content.delete.own_draft'));
  assert.ok(!author.includes('content.delete'));
});

// --- Org role inheritance (§3.3 note) --------------------------------------

test('org owners and admins inherit site_admin without a stored row', () => {
  assert.equal(effectiveWorkspaceRole('owner', null), 'site_admin');
  assert.equal(effectiveWorkspaceRole('admin', null), 'site_admin');
});

test('billing and member org roles grant no workspace access by themselves', () => {
  assert.equal(effectiveWorkspaceRole('billing', null), null);
  assert.equal(effectiveWorkspaceRole('member', null), null);
  assert.equal(effectiveWorkspaceRole('member', 'author'), 'author');
});

test('an explicit workspace role is not downgraded by a weak org role', () => {
  assert.equal(effectiveWorkspaceRole('billing', 'site_admin'), 'site_admin');
});

test('only the owner may delete the org or transfer ownership', () => {
  assert.ok(permissionsForOrgRole('owner').includes('org.delete'));
  assert.ok(!permissionsForOrgRole('admin').includes('org.delete'));
  assert.ok(!permissionsForOrgRole('admin').includes('org.ownership.transfer'));
});

// --- Public ids -------------------------------------------------------------

test('public ids round-trip to the stored uuid', () => {
  const uuid = '0192f8a1-4b2c-7d3e-8f90-a1b2c3d4e5f6';
  const publicId = encodePublicId('content_entry', uuid);
  assert.ok(publicId.startsWith('ce_'));
  assert.equal(decodePublicId('content_entry', publicId), uuid);
});

test('an id of the wrong resource kind is rejected, not silently decoded', () => {
  const publicId = encodePublicId('workspace', '0192f8a1-4b2c-7d3e-8f90-a1b2c3d4e5f6');
  assert.throws(() => decodePublicId('subscriber', publicId));
  assert.equal(isPublicId('subscriber', publicId), false);
  assert.equal(isPublicId('workspace', publicId), true);
});

test('leading-zero uuids survive the round trip', () => {
  const uuid = '00000000-0000-0000-0000-000000000001';
  assert.equal(decodePublicId('user', encodePublicId('user', uuid)), uuid);
});

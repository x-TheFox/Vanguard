/**
 * Safety Module Tests
 *
 * Tests path sanitizer, command blocker, and permission gates.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePath, isProtectedPath } from '../safety/pathSanitizer.js';
import { isCommandBlocked, validateCommand } from '../safety/commandBlocker.js';
import { checkPermissionGate } from '../safety/permissionGates.js';

// ── Path Sanitizer ──────────────────────────────────────────────

describe('sanitizePath', () => {
  it('should reject paths containing ".."', () => {
    assert.throws(() => sanitizePath('../etc/passwd'), { message: /Path traversal/ });
    assert.throws(() => sanitizePath('foo/../../bar'), { message: /Path traversal/ });
    assert.throws(() => sanitizePath('..'), { message: /Path traversal/ });
  });

  it('should normalize backslashes to forward slashes', () => {
    const result = sanitizePath('server\\logs\\latest.log');
    assert.strictEqual(result, 'server/logs/latest.log');
  });

  it('should collapse multiple slashes', () => {
    const result = sanitizePath('server//logs///latest.log');
    assert.strictEqual(result, 'server/logs/latest.log');
  });

  it('should preserve clean paths', () => {
    assert.strictEqual(sanitizePath('server.properties'), 'server.properties');
    assert.strictEqual(sanitizePath('/server/logs/latest.log'), '/server/logs/latest.log');
  });
});

describe('isProtectedPath', () => {
  it('should detect protected /backups/ path', () => {
    assert.ok(isProtectedPath('/backups/backup-001.tar.gz'));
    assert.ok(isProtectedPath('/backups/'));
  });

  it('should detect protected .env path', () => {
    assert.ok(isProtectedPath('.env'));
    assert.ok(isProtectedPath('/home/container/.env'));
  });

  it('should detect protected /.ssh/ path', () => {
    assert.ok(isProtectedPath('/.ssh/authorized_keys'));
    assert.ok(isProtectedPath('/.ssh/'));
  });

  it('should allow non-protected paths', () => {
    assert.ok(!isProtectedPath('server.properties'));
    assert.ok(!isProtectedPath('world/level.dat'));
    assert.ok(!isProtectedPath('/server/logs/latest.log'));
  });
});

// ── Command Blocker ─────────────────────────────────────────────

describe('isCommandBlocked', () => {
  it('should block "op" commands', () => {
    assert.ok(isCommandBlocked('op Notch'));
    assert.ok(isCommandBlocked('op PlayerName'));
    assert.ok(isCommandBlocked('OP AdminUser'));
  });

  it('should block "deop" commands', () => {
    assert.ok(isCommandBlocked('deop Notch'));
    assert.ok(isCommandBlocked('deop PlayerName'));
    assert.ok(isCommandBlocked('DEOP AdminUser'));
  });

  it('should allow safe commands', () => {
    assert.ok(!isCommandBlocked('say Hello World'));
    assert.ok(!isCommandBlocked('list'));
    assert.ok(!isCommandBlocked('whitelist add Player'));
    assert.ok(!isCommandBlocked('time set day'));
    assert.ok(!isCommandBlocked('tp Player1 Player2'));
  });
});

describe('validateCommand', () => {
  it('should return blocked for "op" with reason', () => {
    const result = validateCommand('op Notch');
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes('blocked'));
  });

  it('should return allowed for safe commands', () => {
    const result = validateCommand('say Hello');
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.reason, undefined);
  });
});

// ── Permission Gates ────────────────────────────────────────────

describe('checkPermissionGate', () => {
  it('should allow safe tools without confirmation', () => {
    const result = checkPermissionGate('list_servers', {});
    assert.strictEqual(result.allowed, true);
  });

  it('should block gated tools without confirmation', () => {
    const result = checkPermissionGate('stop_server', {});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes('confirmation'));
  });

  it('should allow gated tools with confirm: true', () => {
    const result = checkPermissionGate('stop_server', { confirm: true });
    assert.strictEqual(result.allowed, true);
  });

  it('should require both confirm and confirm_truncate for restore_backup with truncate', () => {
    // Only confirm, no confirm_truncate — but confirm IS true
    // The logic checks: if toolName === 'restore_backup' AND confirm_truncate === true AND confirm !== true
    // So with only confirm: true and no confirm_truncate, it should be allowed
    const result1 = checkPermissionGate('restore_backup', { confirm: true });
    assert.strictEqual(result1.allowed, true);

    // With confirm_truncate: true but confirm: false/missing
    const result2 = checkPermissionGate('restore_backup', { confirm_truncate: true });
    assert.strictEqual(result2.allowed, false);
    assert.ok(result2.reason?.includes('confirm_truncate'));

    // With both confirm and confirm_truncate
    const result3 = checkPermissionGate('restore_backup', { confirm: true, confirm_truncate: true });
    assert.strictEqual(result3.allowed, true);
  });

  it('should block restore_backup without any confirmation', () => {
    const result = checkPermissionGate('restore_backup', {});
    assert.strictEqual(result.allowed, false);
  });
});

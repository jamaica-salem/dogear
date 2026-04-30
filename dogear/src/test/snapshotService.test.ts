import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { setup, teardown, suite, test } from 'mocha';
import { SnapshotService } from '../snapshotService';

suite('SnapshotService', () => {
  let tmpDir = '';

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates storage directory on construction', () => {
    new SnapshotService(tmpDir);
    assert.ok(fs.existsSync(path.join(tmpDir, '.vscode', 'focus')));
  });

  test('listAll returns empty array when no sessions exist', () => {
    const svc = new SnapshotService(tmpDir);
    assert.deepStrictEqual(svc.listAll(), []);
  });
});

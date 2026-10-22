import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { commitNameStatusArgs, parseNameStatusZ } from './diffNames';

describe('parseNameStatusZ', () => {
  test('parses modified, added, and deleted files from NUL-separated output', () => {
    const text = 'M\0package.json\0A\0src/new file.ts\0D\0old.txt\0';

    assert.deepEqual(parseNameStatusZ(text), [
      { path: 'package.json', originalPath: 'package.json' },
      { path: 'src/new file.ts', originalPath: 'src/new file.ts' },
      { path: 'old.txt', originalPath: 'old.txt' },
    ]);
  });

  test('keeps both paths of a rename or copy', () => {
    const text = 'R100\0src/old.ts\0src/new.ts\0C075\0a.txt\0b.txt\0';

    assert.deepEqual(parseNameStatusZ(text), [
      { path: 'src/new.ts', originalPath: 'src/old.ts' },
      { path: 'b.txt', originalPath: 'a.txt' },
    ]);
  });

  test('returns no files for empty output', () => {
    assert.deepEqual(parseNameStatusZ(''), []);
    assert.deepEqual(parseNameStatusZ('\0'), []);
  });

  test('stops when a record is truncated', () => {
    assert.deepEqual(parseNameStatusZ('M\0ok.txt\0R100\0only-old.ts'), [
      { path: 'ok.txt', originalPath: 'ok.txt' },
    ]);
  });
});

describe('commitNameStatusArgs', () => {
  test('diffs a commit against its parent with rename detection disabled', () => {
    const args = commitNameStatusArgs('C:/repo', 'abc123', 'parent456');

    assert.deepEqual(args.slice(0, 4), ['-C', 'C:/repo', '-c', 'diff.renames=false']);
    assert.ok(args.includes('diff'));
    assert.ok(args.includes('--name-status'));
    assert.ok(args.includes('--no-ext-diff'));
    assert.ok(args.includes('--no-textconv'));
    assert.ok(args.includes('-z'));
    assert.deepEqual(args.slice(-2), ['parent456', 'abc123']);
    assert.equal(args.includes('diff-tree'), false);
  });

  test('diffs a root commit against the empty tree', () => {
    const args = commitNameStatusArgs('/repo', 'abc123', undefined);

    assert.ok(args.includes('diff-tree'));
    assert.ok(args.includes('--root'));
    assert.ok(args.includes('--name-status'));
    assert.ok(args.includes('--no-textconv'));
    assert.equal(args[args.length - 1], 'abc123');
    assert.equal(args.includes('diff'), false);
  });
});

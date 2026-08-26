import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mergeCommitPage, nextLogQuery } from './commitPage';

interface HashCommit {
  readonly hash: string;
}

function commits(...hashes: string[]): HashCommit[] {
  return hashes.map((hash) => ({ hash }));
}

describe('nextLogQuery', () => {
  test('uses skip from the number of already-loaded commits when skip is supported', () => {
    assert.deepEqual(nextLogQuery(200, 200, true), { maxEntries: 200, skip: 200 });
    assert.deepEqual(nextLogQuery(0, 200, true), { maxEntries: 200, skip: 0 });
  });

  test('grows maxEntries from the start when skip is not supported', () => {
    assert.deepEqual(nextLogQuery(200, 200, false), { maxEntries: 400, skip: 0 });
  });
});

describe('mergeCommitPage', () => {
  test('appends a full page of new commits and reports that more remain', () => {
    const existing = commits('a', 'b');
    const page = commits('c', 'd');
    const result = mergeCommitPage(existing, page, 2, true);

    assert.equal(result.skipIgnored, false);
    assert.deepEqual(result.added.map((c) => c.hash), ['c', 'd']);
    assert.deepEqual(result.commits.map((c) => c.hash), ['a', 'b', 'c', 'd']);
    assert.equal(result.hasMore, true);
  });

  test('treats a short page as the end of history', () => {
    const existing = commits('a', 'b');
    const page = commits('c');
    const result = mergeCommitPage(existing, page, 2, true);

    assert.equal(result.hasMore, false);
    assert.deepEqual(result.commits.map((c) => c.hash), ['a', 'b', 'c']);
  });

  test('treats an empty page as the end of history', () => {
    const result = mergeCommitPage(commits('a'), [], 2, true);
    assert.equal(result.hasMore, false);
    assert.equal(result.added.length, 0);
    assert.deepEqual(result.commits.map((c) => c.hash), ['a']);
  });

  test('detects ignored skip when the page repeats already-loaded commits', () => {
    const existing = commits('a', 'b');
    const page = commits('a', 'b');
    const result = mergeCommitPage(existing, page, 2, true);

    assert.equal(result.skipIgnored, true);
    assert.equal(result.added.length, 0);
    assert.deepEqual(result.commits.map((c) => c.hash), ['a', 'b']);
    assert.equal(result.hasMore, true);
  });

  test('does not treat overlap as ignored skip when skip was not requested', () => {
    const existing = commits('a', 'b');
    const page = commits('a', 'b', 'c', 'd');
    const result = mergeCommitPage(existing, page, 4, false);

    assert.equal(result.skipIgnored, false);
    assert.deepEqual(result.added.map((c) => c.hash), ['c', 'd']);
    assert.deepEqual(result.commits.map((c) => c.hash), ['a', 'b', 'c', 'd']);
    assert.equal(result.hasMore, true);
  });

  test('deduplicates commits that appear in both existing and page', () => {
    const existing = commits('a', 'b', 'c');
    const page = commits('c', 'd');
    const result = mergeCommitPage(existing, page, 2, true);

    assert.equal(result.skipIgnored, false);
    assert.deepEqual(result.added.map((c) => c.hash), ['d']);
    assert.deepEqual(result.commits.map((c) => c.hash), ['a', 'b', 'c', 'd']);
  });

  test('stops when a full-size page contains no new commits', () => {
    const existing = commits('a', 'b');
    const page = commits('a', 'b');
    const result = mergeCommitPage(existing, page, 2, false);

    assert.equal(result.skipIgnored, false);
    assert.equal(result.added.length, 0);
    assert.equal(result.hasMore, false);
  });
});

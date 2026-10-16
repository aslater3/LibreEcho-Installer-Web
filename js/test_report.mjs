import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIssueReport, redact, ISSUE_REPOSITORY, MAX_URL_LENGTH } from './report.js';

function fields(url) {
  const parsed = new URL(url);
  return { origin: parsed.origin, path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) };
}

test('report opens the LibreEcho bug form with the user text and the log', () => {
  const report = buildIssueReport({
    summary: 'stuck waiting for recovery',
    whatHappened: 'Pressed Run; it never left step 4.',
    expected: 'Install finishes',
    log: 'line one\nline two\n',
    context: { device: 'Echo Dot 2nd Gen', release: 'radar-puffin-v0.14.0', step: 'Install (failed)' },
    userAgent: 'TestBrowser/1',
  });
  const { origin, path, params } = fields(report.url);
  assert.equal(origin, 'https://github.com');
  assert.equal(path, `/${ISSUE_REPOSITORY}/issues/new`);
  assert.equal(params.template, 'bug.yml');
  assert.equal(params.title, '[Bug]: Browser installer: stuck waiting for recovery');
  assert.equal(params.component, 'browser installer');
  assert.equal(params.version, 'radar-puffin-v0.14.0');
  assert.match(params.steps, /never left step 4/);
  assert.match(params.steps, /Device: Echo Dot 2nd Gen/);
  assert.match(params.steps, /Browser: TestBrowser\/1/);
  assert.equal(params.expected, 'Install finishes');
  assert.match(params.observed, /Full log \(2 lines\)/);
  assert.match(params.observed, /line one\nline two/);
  assert.equal(report.truncated, false);
});

test('a long log keeps its last lines and stays under the URL limit', () => {
  const log = Array.from({ length: 3000 }, (_, i) => `step ${i} pushing payload chunk ${i}`).join('\n');
  const report = buildIssueReport({ summary: 'x', whatHappened: 'y', log });
  assert.ok(report.url.length <= MAX_URL_LENGTH, `url is ${report.url.length}`);
  assert.equal(report.truncated, true);
  assert.ok(report.shownLines > 20 && report.shownLines < 3000);
  const { params } = fields(report.url);
  assert.match(params.observed, /step 2999 pushing/);
  assert.doesNotMatch(params.observed, /step 0 pushing/);
  assert.match(params.observed, /copied to the clipboard/);
  assert.equal(report.fullLog.split('\n').length, 3000);
});

test('the log can be left out', () => {
  const report = buildIssueReport({ summary: 'x', whatHappened: 'y', includeLog: false, log: 'secret stuff' });
  const { params } = fields(report.url);
  assert.doesNotMatch(params.observed, /secret stuff/);
  assert.match(params.observed, /chose not to include/);
});

test('serials, MACs, private addresses and secrets are removed', () => {
  const text = redact('serial G090L90964010665 mac 00:11:22:aa:bb:cc ip 192.168.1.20 and 10.0.0.5 psk=hunter2 token: abc');
  assert.doesNotMatch(text, /G090L90964010665|00:11:22|192\.168|10\.0\.0\.5|hunter2|abc/);
  const report = buildIssueReport({ summary: 'G090L90964010665', whatHappened: 'mac 00:11:22:aa:bb:cc', log: 'password=x1' });
  assert.doesNotMatch(decodeURIComponent(report.url), /G090L90964010665|00:11:22:aa|x1/);
});

test('backticks in the log cannot close the code block early', () => {
  const report = buildIssueReport({ summary: 'x', whatHappened: 'y', log: 'before\n```\nafter' });
  const { params } = fields(report.url);
  assert.equal(params.observed.match(/```/g).length, 2);
});

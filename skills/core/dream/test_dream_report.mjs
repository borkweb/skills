// test_dream_report.mjs — drives dream-report.mjs only as a child process, in a temp box with its own HOME
// and git config. No browser is opened (BORK_DREAM_REPORT_OPEN=0) and the server binds a loopback port.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test, { after } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'dream-report.mjs');
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'drp-')));
const HOME = join(BOX, 'home');
mkdirSync(HOME);
writeFileSync(join(BOX, 'gitconfig'), '');
after(() => rmSync(BOX, { recursive: true, force: true }));

const ENV = {
  PATH: process.env.PATH,
  HOME,
  GIT_CONFIG_GLOBAL: join(BOX, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: BOX,
  BORK_DREAM_REPORT_OPEN: '0',
};

let n = 0;
const fresh = (name) => {
  const d = join(BOX, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const report = (id, extra = {}) => ({
  id,
  title: 'Dream report',
  date: id.slice(0, 10),
  sections: [
    {
      title: 'Review criteria',
      items: [
        { id: 'row-1', kind: 'add', title: 'New class', detail: '<script>alert(1)</script>', evidence: ['repo@abc/slice-1'], recommended: 'keep' },
        { id: 'row-2', kind: 'retire', title: 'Old class', before: 'old text', after: '' },
      ],
    },
  ],
  findings: [{ title: 'Harness bugs', body: 'none' }],
  ...extra,
});
const build = (data, dir, cwd = BOX, extra = []) => {
  const file = join(fresh('data'), 'report.json');
  writeFileSync(file, JSON.stringify(data));
  return spawnSync('node', [SCRIPT, 'build', '--data', file, ...(dir ? ['--dir', dir] : []), ...extra], { env: ENV, cwd, encoding: 'utf8' });
};

test('build writes a private self-contained page and never emits raw markup from the data', () => {
  const dir = fresh('reports');
  const r = build(report('2026-03-01-dream-ab12'), dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const file = join(dir, '2026-03-01-dream-ab12', 'index.html');
  assert.strictEqual(r.stdout, `${file}\n`);
  const html = readFileSync(file, 'utf8');
  assert.ok(!html.includes('<script>alert(1)'), 'data markup must be escaped inside the embedded JSON');
  assert.ok(html.includes('\\u003cscript>alert(1)'));
  assert.ok(!/(src|href)=["']?https?:/.test(html), 'the page loads nothing from the network');
  assert.strictEqual(statSync(file).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(dir, 'index.html'), 'utf8').includes('2026-03-01-dream-ab12/index.html'));
});

test('only the newest five reports are kept, and a rebuild replaces a report in place', () => {
  const dir = fresh('reports');
  for (let day = 1; day <= 7; day++) assert.strictEqual(build(report(`2026-03-0${day}-dream-aaaa`), dir).status, 0);
  const kept = () => readdirSync(dir).filter((x) => x !== 'index.html').sort();
  assert.deepStrictEqual(kept(), [3, 4, 5, 6, 7].map((d) => `2026-03-0${d}-dream-aaaa`));
  assert.strictEqual(build(report('2026-03-07-dream-aaaa', { title: 'Second build' }), dir).status, 0);
  assert.strictEqual(kept().length, 5);
  assert.ok(readFileSync(join(dir, 'index.html'), 'utf8').includes('Second build'));
  // An older id built last is still the current report and is not deleted by its own build.
  assert.strictEqual(build(report('2026-01-01-dream-old1'), dir).status, 0);
  assert.ok(kept().includes('2026-01-01-dream-old1'));
  assert.strictEqual(kept().length, 5);
  // A directory the tool did not write is never deleted.
  mkdirSync(join(dir, 'notes'));
  assert.strictEqual(build(report('2026-03-09-dream-bbbb'), dir).status, 0);
  assert.ok(existsSync(join(dir, 'notes')));
});

test('inside a repo the default directory is output/dream and it is excluded locally, not in .gitignore', () => {
  const repo = fresh('repo');
  git(repo, 'init', '-q');
  const r = build(report('2026-03-01-dream-ab12'), null, repo);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(existsSync(join(realpathSync(repo), 'output', 'dream', '2026-03-01-dream-ab12', 'index.html')));
  assert.strictEqual(git(repo, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(repo, '.gitignore')));
  assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/output\/dream\/$/m);
  assert.strictEqual(build(report('2026-03-02-dream-ab12'), null, repo).status, 0);
  assert.strictEqual(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').match(/output\/dream/g).length, 1);
});

test('a directory with tracked files, a bad id and duplicate item ids are refused', () => {
  const repo = fresh('repo');
  git(repo, 'init', '-q');
  mkdirSync(join(repo, 'reports'));
  writeFileSync(join(repo, 'reports', 'keep.txt'), 'x');
  git(repo, 'add', 'reports/keep.txt');
  assert.notStrictEqual(build(report('2026-03-01-dream-ab12'), join(repo, 'reports'), repo).status, 0);
  assert.notStrictEqual(build(report('../escape'), fresh('reports')).status, 0);
  const dup = report('2026-03-01-dream-ab12');
  dup.sections[0].items[1].id = 'row-1';
  assert.notStrictEqual(build(dup, fresh('reports')).status, 0);
});

const startServer = (reportDir, out) =>
  new Promise((resolveStart, reject) => {
    const child = spawn('node', [SCRIPT, 'serve', '--report', reportDir, '--out', out], { env: ENV });
    let err = '';
    const done = new Promise((r) => child.on('exit', (code) => r(code)));
    child.stderr.on('data', (c) => {
      err += c;
      const m = err.match(/waiting for decisions at (http:\/\/127\.0\.0\.1:\d+)\/\?t=([0-9a-f]+)/);
      if (m) resolveStart({ child, done, origin: m[1], token: m[2] });
    });
    child.on('error', reject);
  });

test('serve refuses bad requests, then writes one valid submission and exits', async () => {
  const dir = fresh('reports');
  assert.strictEqual(build(report('2026-03-01-dream-ab12'), dir).status, 0);
  const reportDir = join(dir, '2026-03-01-dream-ab12');
  const out = join(fresh('run'), 'decisions.json');
  const s = await startServer(reportDir, out);
  try {
    const post = (body, token = s.token, headers = {}) =>
      fetch(`${s.origin}/decisions?t=${token}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.strictEqual((await fetch(`${s.origin}/`)).status, 403);
    const pageRes = await fetch(`${s.origin}/?t=${s.token}`);
    assert.strictEqual(pageRes.status, 200);
    assert.match(pageRes.headers.get('content-security-policy'), /default-src 'none'/);
    const good = { id: '2026-03-01-dream-ab12', decisions: { 'row-1': { decision: 'keep' }, 'row-2': { decision: 'change', comment: ' keep the citation ' } } };
    assert.strictEqual((await post(good, 'wrong')).status, 403);
    assert.strictEqual((await post(good, s.token, { origin: 'http://evil.example' })).status, 403);
    assert.strictEqual((await post({ ...good, decisions: { 'row-1': { decision: 'keep' } } })).status, 400);
    assert.strictEqual((await post({ ...good, decisions: { ...good.decisions, 'row-2': { decision: 'change', comment: ' ' } } })).status, 400);
    assert.strictEqual((await post({ ...good, decisions: { ...good.decisions, extra: { decision: 'keep' } } })).status, 400);
    assert.ok(!existsSync(out));
    assert.strictEqual((await post(good)).status, 200);
    assert.strictEqual(await s.done, 0);
  } finally {
    s.child.kill();
  }
  const saved = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepStrictEqual(saved.decisions, { 'row-1': { decision: 'keep', comment: '' }, 'row-2': { decision: 'change', comment: 'keep the citation' } });
  assert.strictEqual(statSync(out).mode & 0o777, 0o600);
  assert.deepStrictEqual(JSON.parse(readFileSync(join(reportDir, 'decisions.json'), 'utf8')), saved);

  // A final rebuild keeps the decisions on the page and can no longer be served for decisions.
  assert.strictEqual(build(report('2026-03-01-dream-ab12', { state: 'final' }), dir).status, 0);
  assert.ok(readFileSync(join(reportDir, 'index.html'), 'utf8').includes('keep the citation'));
  const again = spawnSync('node', [SCRIPT, 'serve', '--report', reportDir, '--out', out], { env: ENV, encoding: 'utf8' });
  assert.notStrictEqual(again.status, 0);
});

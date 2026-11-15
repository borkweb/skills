// test_testkit.mjs — the desk tests' box removes itself at exit even while a background writer still holds files in it.
// K8: test_clean.mjs failed at exit with ENOTEMPTY when the `clean` that `set --state done` starts in the background
// was still writing cleanup.log into the box the exit handler was removing.
import assert from 'node:assert';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERE, NODE } from './testkit.mjs';

test('K8 a box is removed at exit even while a detached process is still adding files to it', () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'testkit-')));
  try {
    const report = join(work, 'root.txt');
    const kit = join(HERE, 'testkit.mjs');
    // The child makes a box holding a few thousand files, starts a background writer that keeps creating files in it
    // as fast as it can for several seconds, and exits at once, so the exit handler removes the box under the writer's feet.
    const child = [
      `import { newBox } from ${JSON.stringify(kit)};`,
      `import { spawn } from 'node:child_process';`,
      `import { mkdirSync, writeFileSync } from 'node:fs';`,
      `const b = newBox();`,
      `mkdirSync(b.root + '/late');`,
      `for (let i = 0; i < 3000; i++) writeFileSync(b.root + '/late/seed' + i, '');`,
      `writeFileSync(${JSON.stringify(report)}, b.root);`,
      `spawn('/bin/sh', ['-c', 'i=0; while [ $i -lt 20000 ]; do : > "$0/late/f$i"; i=$((i+1)); done', b.root], { detached: true, stdio: 'ignore' }).unref();`,
    ].join('\n');
    const r = spawnSync(NODE, ['--input-type=module', '-e', child], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `the child must exit 0 (exit ${r.status}): ${r.stderr}`);
    const root = readFileSync(report, 'utf8');
    // give the writer time to finish in case the exit handler gave up early, then check the box is gone
    const end = Date.now() + 8000;
    while (existsSync(root) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    assert.equal(existsSync(root), false, `the box ${root} must be gone`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

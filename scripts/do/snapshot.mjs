import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { hash } from './store.mjs';
import { relativePath, requireThat } from './policy.mjs';

// No Git mutation, shell execution, ignored-file assumptions, or symlink traversal.
export function fingerprint(repo, scope) {
  requireThat(realpathSync(repo) === repo, 'repo must be a canonical real path');
  const entries = new Map(); let bytes = 0;
  function visit(relative) {
    relativePath(relative);
    const absolute = resolve(repo, relative);
    requireThat(absolute === repo || absolute.startsWith(repo + sep), 'scope escapes repository');
    // Never traverse a symlink hidden in a parent component.
    const parts = relative === '.' ? [] : relative.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = join(repo, ...parts.slice(0, i));
      try { requireThat(!lstatSync(parent).isSymbolicLink(), `symlink scope parent: ${parent}`); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    let info;
    try { info = lstatSync(absolute); } catch (error) { if (error.code !== 'ENOENT') throw error; entries.set(relative, 'missing'); return; }
    if (info.isSymbolicLink()) entries.set(relative, `link:${readlinkSync(absolute)}`);
    else if (info.isDirectory()) {
      entries.set(relative, `directory:${info.mode & 0o777}`);
      for (const name of readdirSync(absolute).sort()) if (name !== '.git') visit(relative === '.' ? name : `${relative}/${name}`);
    } else {
      requireThat(info.isFile(), `unsupported snapshot file: ${relative}`);
      bytes += info.size; requireThat(bytes <= 64 * 1024 * 1024, 'snapshot exceeds 64 MiB; narrow explicit scope');
      entries.set(relative, `${info.mode & 0o777}:${hash(readFileSync(absolute))}`);
    }
    requireThat(entries.size <= 10000, 'snapshot exceeds 10000 paths; narrow explicit scope');
  }
  scope.forEach(visit);
  const files = Object.fromEntries([...entries].sort((a, b) => a[0].localeCompare(b[0])));
  return { digest: hash(JSON.stringify(files)), entries: entries.size, files };
}

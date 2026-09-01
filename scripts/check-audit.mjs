/**
 * Fails when a branch introduces a dependency advisory that main does not
 * already have.
 *
 * An absolute `npm audit` gate is not usable here. The mobile app pulls in
 * Expo and React Native, which between them carry dozens of open advisories at
 * any moment, and Electron is rarely a patch behind for long. A gate that is
 * red on an unchanged tree teaches everyone to merge past it, which is worse
 * than no gate: the one advisory a change actually introduces arrives in the
 * same red wall as the thirty it inherited.
 *
 * So this compares against the base ref instead. Whatever main already carries
 * is the baseline; what fails the build is a *new* advisory id, at or above
 * the threshold, that this branch is responsible for. Lowering the count is
 * always welcome and never required.
 *
 *   node scripts/check-audit.mjs --base origin/main . packages/desktop packages/mobile
 *
 * Options:
 *   --base <ref>        what to compare against          (default origin/main)
 *   --severity <level>  lowest severity that fails       (default high)
 *
 * Exit status: 0 nothing new, 1 a new advisory at or above the threshold,
 * 2 the comparison could not be made (no base ref, npm could not reach the
 * registry) - unknown is not the same as broken, and the caller decides.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

const args = process.argv.slice(2);
let base = 'origin/main';
let severity = 'high';
const dirs = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--base') base = args[++i];
  else if (args[i] === '--severity') severity = args[++i];
  else dirs.push(args[i]);
}
if (dirs.length === 0) dirs.push('.');
if (!(severity in RANK)) {
  console.error(`unknown severity '${severity}'; expected one of ${Object.keys(RANK).join(', ')}`);
  process.exit(2);
}
const threshold = RANK[severity];

/** Thrown when the answer is unknown, as opposed to known and bad. */
class Unverifiable extends Error {}

function git(...argv) {
  const r = spawnSync('git', argv, { encoding: 'utf8' });
  if (r.status !== 0) throw new Unverifiable(`git ${argv.join(' ')}: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

/**
 * The advisories npm reports for a directory, keyed by advisory id.
 *
 * `npm audit` resolves the lockfile against the registry; it does not need
 * node_modules, which is what makes auditing a bare worktree cheap. It exits
 * non-zero whenever it finds anything, so the status says nothing about
 * whether the run itself worked - the JSON on stdout does.
 */
function advisoriesIn(dir) {
  const r = spawnSync('npm', ['audit', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    throw new Unverifiable(`npm audit in ${dir} produced no report: ${(r.stderr || '').trim()}`);
  }
  if (report.error) {
    throw new Unverifiable(`npm audit in ${dir}: ${report.error.summary ?? report.error.code}`);
  }

  const found = new Map();
  for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      // A string `via` is another package in the same chain, not an advisory
      // of its own; the advisory it points at is reported under that package.
      if (typeof via !== 'object' || via.source == null) continue;
      const id = String(via.source);
      const entry = found.get(id) ?? {
        id,
        title: via.title ?? '(no title)',
        url: via.url ?? '',
        severity: via.severity ?? vuln.severity ?? 'info',
        through: new Set(),
      };
      entry.through.add(name);
      found.set(id, entry);
    }
  }
  return found;
}

/**
 * The base ref, checked out somewhere this can audit it.
 *
 * A whole worktree rather than the two manifest files, because auditing a
 * workspace root needs every workspace's package.json to be where the lockfile
 * says it is - and reconstructing that by hand is a second way to be wrong
 * about what the base actually contains.
 */
function baseWorktree(ref) {
  try {
    git('rev-parse', '--verify', `${ref}^{commit}`);
  } catch {
    throw new Unverifiable(`'${ref}' is not a ref here; fetch it before auditing against it`);
  }
  const path = mkdtempSync(join(tmpdir(), 'audit-base-'));
  git('worktree', 'add', '--detach', '--quiet', path, ref);
  return path;
}

let workPath = null;
let status = 0;
try {
  workPath = baseWorktree(base);

  for (const dir of dirs) {
    const label = dir === '.' ? '(root)' : dir;
    if (!existsSync(join(dir, 'package-lock.json'))) {
      console.log(`  --  ${label}: no lockfile, nothing to audit`);
      continue;
    }

    const current = advisoriesIn(dir);
    const baseDir = join(workPath, dir);
    // A package that does not exist on the base ref is entirely new, and every
    // advisory it carries arrived with it.
    const before = existsSync(join(baseDir, 'package-lock.json'))
      ? advisoriesIn(baseDir)
      : new Map();

    const introduced = [...current.values()].filter((a) => !before.has(a.id));
    const failing = introduced.filter((a) => RANK[a.severity] >= threshold);
    const inherited = current.size - introduced.length;

    if (failing.length > 0) status = 1;

    const verdict = failing.length > 0 ? 'FAIL' : introduced.length > 0 ? 'warn' : ' ok ';
    console.log(
      `  ${verdict}  ${label}: ${current.size} advisory(ies), ` +
        `${inherited} already on ${base}, ${introduced.length} new`,
    );
    for (const a of introduced.sort((x, y) => RANK[y.severity] - RANK[x.severity])) {
      const mark = RANK[a.severity] >= threshold ? '!' : '-';
      console.log(`        ${mark} ${a.severity.padEnd(8)} ${a.title}`);
      console.log(`          via ${[...a.through].sort().join(', ')}  ${a.url}`);
    }
  }
} catch (err) {
  if (!(err instanceof Unverifiable)) throw err;
  console.error(`\ncould not compare against ${base}: ${err.message}`);
  console.error('Nothing is known to be wrong; the check simply could not run.');
  status = 2;
} finally {
  if (workPath) {
    spawnSync('git', ['worktree', 'remove', '--force', workPath], { stdio: 'ignore' });
    rmSync(workPath, { recursive: true, force: true });
  }
}

if (status === 1) {
  console.error(
    `\nThis branch introduces at least one ${severity}-or-worse advisory that ` +
      `${base} does not have.\nUpdate the dependency, or drop it.`,
  );
} else if (status === 0) {
  console.log(`\nNo new ${severity}-or-worse advisory relative to ${base}.`);
}
process.exit(status);

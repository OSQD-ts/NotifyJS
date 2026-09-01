/**
 * Works out the next version from the commits since the last release tag.
 *
 * The version is derived rather than typed, so that nobody has to remember
 * whether the last release was 0.3.1 or 0.3.2, and so the number always
 * matches what actually changed. The input is the one thing this project
 * already writes consistently: a `Type:` prefix on every commit subject.
 *
 *   node scripts/next-version.mjs                  # explain the decision
 *   node scripts/next-version.mjs --json           # for a program to read
 *   node scripts/next-version.mjs --github-output  # key=value for a workflow
 *
 * Options:
 *   --from <ref>   compare against this instead of the last v* tag
 *   --rolling      never return the current version; bump a patch if nothing
 *                  else asks for one. For the prerelease published from the
 *                  default branch, which has to sort *above* the last release
 *                  rather than below it.
 *
 * Two rules are worth knowing before reading the table below.
 *
 * While the major version is 0, a breaking change bumps the *minor*, not the
 * major. 0.x already means "anything can change"; letting the first `Feat!:`
 * silently declare 1.0.0 would make the most significant number in the project
 * a side effect of a commit message. 1.0.0 is a decision, taken by editing the
 * manifests and tagging by hand.
 *
 * And with no release tag in the repository yet, the first version is exactly
 * what the manifests already claim to be - the project says it is 0.1.0, so
 * the first tag is v0.1.0 rather than a bump away from it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What each commit type does to the version.
 *
 * `refactor` earns a patch here, which conventional-commits would not do. In
 * this repository `Refactor:` has meant things like "Security improvements" -
 * changes people need - and a type that reliably produces no release is a type
 * that quietly strands work on main.
 *
 * Anything absent from this table releases nothing on its own: `CI`, `Docs`
 * and `Chore` are about the repository, not about what people install.
 */
const BUMPS = {
  feat: 'minor',
  feature: 'minor',
  fix: 'patch',
  bugfix: 'patch',
  perf: 'patch',
  refactor: 'patch',
  revert: 'patch',
  security: 'patch',
  build: null,
  chore: null,
  ci: null,
  docs: null,
  style: null,
  test: null,
};

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

const argv = process.argv.slice(2);
const wants = (flag) => argv.includes(flag);
let from = null;
const fromAt = argv.indexOf('--from');
if (fromAt !== -1) from = argv[fromAt + 1];

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // A repository with no release tag yet is the normal first case, not an
    // error worth printing 'fatal: No names found' about.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** The last release tag reachable from HEAD, or null if there has never been one. */
function lastReleaseTag() {
  try {
    // --match keeps `latest` and any other non-version tag out of this; it is
    // a rolling pointer, not a release, and describing against it would make
    // every version look like it had already been cut.
    return git('describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0', 'HEAD').trim() || null;
  } catch {
    return null;
  }
}

/** Commit subjects and bodies since `ref`, newest first. */
function commitsSince(ref) {
  // A record separator between commits and a unit separator between fields:
  // a commit body contains newlines, and splitting on those would read the
  // second paragraph of one message as the subject of another commit.
  const range = ref ? `${ref}..HEAD` : 'HEAD';
  const raw = git('log', range, '--no-merges', '--format=%H%x1f%s%x1f%b%x1e');
  return raw
    .split('\x1e')
    .map((entry) => entry.replace(/^\n/, ''))
    .filter((entry) => entry.trim() !== '')
    .map((entry) => {
      const [sha, subject, body] = entry.split('\x1f');
      return { sha: sha.slice(0, 8), subject, body: body ?? '' };
    });
}

/** What one commit asks for: 'major', 'minor', 'patch', or 'none'. */
export function classify({ subject, body }) {
  const m = /^\s*([A-Za-z]+)(\([^)]*\))?(!)?\s*:\s*(.*)$/.exec(subject ?? '');
  if (!m) return { level: 'none', type: null, breaking: false };

  const type = m[1].toLowerCase();
  // A footer anywhere in the body, not only at the end, and tolerant of what
  // is in front of it. A squash merge concatenates every original message into
  // one body, and GitHub writes them as a bulleted list - so the footer that
  // was at the start of a line in the branch arrives as `* BREAKING CHANGE:`
  // or indented under one. Missing that is how a breaking change ships as a
  // patch. Still uppercase-only, which is what Conventional Commits specifies
  // and what keeps prose like "no breaking change: ..." out of it.
  const breaking = m[3] === '!' || /^[\s*+-]*BREAKING[ -]CHANGE:/m.test(body ?? '');

  if (breaking) return { level: 'major', type, breaking: true };
  // An unrecognised type releases nothing rather than defaulting to a patch.
  // Guessing here is how `License Rename` becomes a version people install.
  const level = Object.hasOwn(BUMPS, type) ? (BUMPS[type] ?? 'none') : 'none';
  return { level, type, breaking: false };
}

/** `1.2.3-rc.1` -> `[1, 2, 3]`. Anything else is a bug worth stopping on. */
function parse(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) throw new Error(`'${version}' is not a version this can count from`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function bump(current, level) {
  const [major, minor, patch] = parse(current);
  // See the note at the top: 1.0.0 is a decision, not a consequence.
  const effective = major === 0 && level === 'major' ? 'minor' : level;
  if (effective === 'major') return `${major + 1}.0.0`;
  if (effective === 'minor') return `${major}.${minor + 1}.0`;
  if (effective === 'patch') return `${major}.${minor}.${patch + 1}`;
  return `${major}.${minor}.${patch}`;
}

// Two separate questions, and conflating them was a bug: `--from <sha>` says
// which commits to read, and says nothing about what version we are counting
// up from. That still comes from the last release tag, or - when there is not
// one - from the manifests.
const tag = lastReleaseTag();
const range = from ?? tag;
const countingFrom = from && /^v?\d+\.\d+\.\d+/.test(from) ? from : tag;

const commits = commitsSince(range);
const classified = commits.map((c) => ({ ...c, ...classify(c) }));

const level = classified.reduce(
  (worst, c) => (RANK[c.level] > RANK[worst] ? c.level : worst),
  'none',
);

const manifestVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const current = countingFrom ? countingFrom.replace(/^v/, '') : manifestVersion;

// No tag yet means no release yet, and the first one is the version the
// project already says it is. Bumping past it would publish a version whose
// predecessor never existed.
const seeding = !countingFrom;

// `--rolling` is for the `x.y.z-main.N` prerelease the default branch
// publishes under npm's `next` tag. Left at the current version it would
// produce `0.4.0-main.7` *after* 0.4.0 was released - and a prerelease sorts
// below its release, so `npm i @osqd/notifyjs@next` would hand people
// something older than `@latest`. A patch floor keeps it a preview of what is
// coming rather than a stale copy of what already shipped.
//
// Not while seeding: there, the current version has not been released yet, so
// a prerelease of it is exactly right.
const floor = wants('--rolling') && !seeding && level === 'none' ? 'patch' : level;
const next = seeding ? parse(current).join('.') : bump(current, floor);
const releasable = seeding ? commits.length > 0 : level !== 'none';
const demoted = !seeding && level === 'major' && parse(current)[0] === 0;

if (wants('--json')) {
  console.log(
    JSON.stringify(
      {
        from: range,
        current,
        next,
        level: seeding ? 'seed' : level,
        releasable,
        seeding,
        commits: classified.map(({ sha, subject, level: l, type }) => ({
          sha,
          subject,
          level: l,
          type,
        })),
      },
      null,
      2,
    ),
  );
} else if (wants('--github-output')) {
  // Shape-checked before it is printed. A step output is parsed line by line,
  // so a newline reaching this would forge outputs for every later step.
  if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`refusing to emit '${next}'`);
  console.log(`current=${current}`);
  console.log(`next=${next}`);
  console.log(`tag=v${next}`);
  console.log(`level=${seeding ? 'seed' : level}`);
  console.log(`releasable=${releasable}`);
} else {
  const since = range ? `since ${range}` : 'since the beginning of history (no release tag yet)';
  console.log(`${commits.length} commit(s) ${since}\n`);
  for (const c of classified) {
    const mark = c.level === 'none' ? '  -  ' : c.level.padEnd(5);
    console.log(`  ${mark} ${c.sha}  ${c.subject}`);
  }
  console.log();
  if (seeding) {
    console.log(`  ${current} -> ${next}   the first release is the version the manifests claim`);
  } else if (!releasable) {
    console.log(`  ${current} -> nothing   no commit here asks for a release`);
  } else {
    const why = demoted ? `${level}, held to minor while this is 0.x` : level;
    console.log(`  ${current} -> ${next}   (${why})`);
  }
}

/**
 * Checks that every action a workflow pins still accepts the inputs it passes.
 *
 * Actions here are pinned to a commit SHA, and nothing updates those pins
 * automatically - so each one is edited by hand, against a version whose
 * inputs may have moved. The failure that causes is almost never exotic: a
 * newer major renames an input, drops one, or makes one required. The job that
 * would notice runs at release time, possibly weeks later.
 *
 * That gap matters most for the actions CI never executes - the docker login
 * and the release publisher live only in release.yml, and no CI job invokes
 * either. Reading the action's own `action.yml` at the pinned SHA does not run
 * anything, needs no write access, and catches exactly that class of breakage.
 *
 *   node scripts/check-action-contracts.mjs .github/workflows/*.yml
 *
 * A GITHUB_TOKEN in the environment is used when present, purely for the
 * higher rate limit.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: check-action-contracts.mjs <workflow.yml...>');
  process.exit(1);
}

/**
 * Workflow YAML, via Python.
 *
 * Deliberately not a hand-rolled parser: this is a correctness check, and one
 * that silently mis-parses a workflow would report success while understanding
 * nothing. PyYAML is present on the runner image and on any machine with a
 * normal Python.
 */
function parseYaml(path) {
  const out = execFileSync(
    'python3',
    ['-c', 'import sys,yaml,json;json.dump(yaml.safe_load(open(sys.argv[1])),sys.stdout)', path],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

/** Every `uses:` in a workflow, with the inputs the step passes to it. */
function stepsOf(workflow) {
  const found = [];
  for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.uses !== 'string') continue;
      found.push({ job: jobName, uses: step.uses, with: Object.keys(step.with ?? {}) });
    }
  }
  return found;
}

/** Thrown when the answer is unknown, as opposed to known and bad. */
class Unverifiable extends Error {}

/**
 * The same action is used by many jobs - `actions/checkout` appears eight
 * times across these two workflows - and each pinned ref has one answer.
 */
const cache = new Map();

async function actionInputs(owner, repo, ref, subpath) {
  const key = `${owner}/${repo}/${subpath}@${ref}`;
  if (cache.has(key)) return cache.get(key);

  const headers = { accept: 'application/vnd.github.raw' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  // Either spelling is legal, and both are used in the wild.
  for (const name of ['action.yml', 'action.yaml']) {
    const path = subpath ? `${subpath}/${name}` : name;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });

    // A 404 is an answer: this ref has no such file, try the other spelling.
    if (response.status === 404) continue;

    // A rate limit is *not* an answer. Reporting it as an incompatible action
    // would fail the build for a reason that has nothing to do with the code,
    // and would teach everyone to ignore this check.
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining === '0' || /rate limit/i.test(await response.text())) {
        throw new Unverifiable(
          'GitHub API rate limit reached' +
            (process.env.GITHUB_TOKEN ? '' : ' - set GITHUB_TOKEN for a higher allowance'),
        );
      }
      throw new Unverifiable(`HTTP ${response.status} fetching ${key}`);
    }
    if (!response.ok) throw new Unverifiable(`HTTP ${response.status} fetching ${key}`);

    const body = await response.text();
    const parsed = execFileSync(
      'python3',
      ['-c', 'import sys,yaml,json;json.dump(yaml.safe_load(sys.stdin),sys.stdout)'],
      { input: body, encoding: 'utf8' },
    );
    const inputs = Object.keys(JSON.parse(parsed)?.inputs ?? {});
    cache.set(key, inputs);
    return inputs;
  }

  // Both spellings 404'd. That is a real finding: the ref does not resolve to
  // an action, which is what a bad SHA bump looks like.
  throw new Error(`no action.yml at ${owner}/${repo}@${ref}${subpath ? ` (${subpath})` : ''}`);
}

const problems = [];
const unverifiable = [];
let checked = 0;

for (const file of files) {
  const workflow = parseYaml(file);
  for (const step of stepsOf(workflow)) {
    // `./local` and docker:// actions have no upstream contract to read.
    if (step.uses.startsWith('./') || step.uses.startsWith('docker://')) continue;

    const [repoPart, ref] = step.uses.split('@');
    if (!ref) {
      problems.push(`${file} (${step.job}): ${step.uses} is not pinned to a ref`);
      continue;
    }
    const [owner, repo, ...rest] = repoPart.split('/');

    let inputs;
    try {
      inputs = await actionInputs(owner, repo, ref, rest.join('/'));
    } catch (err) {
      if (err instanceof Unverifiable) {
        // Not a verdict on the action. Recorded separately so the exit status
        // says "could not check" rather than "this is broken".
        unverifiable.push(`${step.uses} - ${err.message}`);
        continue;
      }
      // A ref that cannot be resolved is the other thing a bad bump produces.
      problems.push(`${file} (${step.job}): ${step.uses} - ${err.message}`);
      continue;
    }
    checked += 1;

    const unknown = step.with.filter((k) => !inputs.includes(k));
    if (unknown.length > 0) {
      problems.push(
        `${file} (${step.job}): ${step.uses} does not accept ${unknown.join(', ')}` +
          `\n    it declares: ${inputs.join(', ') || '(none)'}`,
      );
    }
    console.log(`  ok  ${step.uses.padEnd(64)} ${step.with.length} input(s)`);
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nAn action was bumped to a version that no longer fits how it is called.');
  process.exit(1);
}

if (unverifiable.length > 0) {
  // Distinct exit status and wording, because "we could not look" and "we
  // looked and it is wrong" call for completely different responses.
  console.error(`\ncould not verify ${unverifiable.length} action(s):\n`);
  for (const u of new Set(unverifiable)) console.error(`  ${u}`);
  console.error('\nNothing is known to be wrong; the check simply could not run.');
  process.exit(2);
}

console.log(`\n${checked} pinned action(s) still accept every input passed to them.`);

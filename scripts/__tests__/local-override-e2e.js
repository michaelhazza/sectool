'use strict';
// End-to-end smoke test for LOCAL-OVERRIDE preservation via sync.js.
// Sets up a synthetic framework + consumer in tmp, exercises:
//   1. --adopt first run → records consumer file with override block hash
//   2. Operator edits inside override block → next sync sees clean, updates
//   3. Operator edits outside override block → next sync writes .framework-new
//   4. Framework adds/removes override blocks → consumer overrides preserved

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const tmp = path.join(os.tmpdir(), 'lo-e2e-' + process.pid);
fs.rmSync(tmp, { recursive: true, force: true });
const fwRoot = path.join(tmp, 'framework');
const consRoot = path.join(tmp, 'consumer');
fs.mkdirSync(path.join(fwRoot, '.claude'), { recursive: true });
fs.mkdirSync(path.join(fwRoot, 'docs'), { recursive: true });
fs.mkdirSync(path.join(consRoot, '.claude'), { recursive: true });

// Copy real sync.js so it has all its supporting code
const realFwRoot = path.resolve(__dirname, '..', '..');
fs.copyFileSync(path.join(realFwRoot, 'sync.js'), path.join(fwRoot, 'sync.js'));

// Synthetic framework files
fs.writeFileSync(path.join(fwRoot, '.claude', 'FRAMEWORK_VERSION'), '2.10.0\n');
fs.writeFileSync(path.join(fwRoot, '.claude', 'CHANGELOG.md'), '# CHANGELOG\n\n## 2.10.0\n\nLocal overrides ship.\n');
fs.writeFileSync(path.join(fwRoot, 'manifest.json'), JSON.stringify({
  frameworkVersion: '2.10.0',
  managedFiles: [
    { path: 'docs/principles.md', category: 'reference', mode: 'sync', substituteAt: 'never' },
    { path: '.claude/FRAMEWORK_VERSION', category: 'version', mode: 'sync', substituteAt: 'never' },
    { path: '.claude/CHANGELOG.md', category: 'changelog', mode: 'sync', substituteAt: 'never' },
  ],
  removedFiles: [],
  doNotTouch: [],
}, null, 2));

const fwV1 = `# Principles

Standard intro.

## Examples

<!-- LOCAL-OVERRIDE:start name="examples" -->
- Framework default example
<!-- LOCAL-OVERRIDE:end name="examples" -->

## Footer
`;
fs.writeFileSync(path.join(fwRoot, 'docs', 'principles.md'), fwV1);

function runSync(args = '') {
  return execSync(`node "${path.join(fwRoot, 'sync.js').replace(/\\/g, '/')}" ${args}`, {
    cwd: consRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function pass(name) { process.stdout.write(`  ok  ${name}\n`); }

// STEP 1 — --adopt the framework
const out1 = runSync('--adopt');
assert.ok(out1.includes('updated') || out1.includes('new'), 'expected --adopt to deploy files');
const consumerFile = path.join(consRoot, 'docs', 'principles.md');
assert.ok(fs.existsSync(consumerFile), 'principles.md should be deployed');
const contentAfterAdopt = fs.readFileSync(consumerFile, 'utf8');
assert.ok(contentAfterAdopt.includes('<!-- LOCAL-OVERRIDE:start name="examples" -->'), 'override marker present');
assert.ok(contentAfterAdopt.includes('Framework default example'), 'framework default content present');
pass('--adopt deploys framework file with override marker + default content');

// STEP 2 — operator edits inside the override block; subsequent sync should NOT write .framework-new
const edited = contentAfterAdopt.replace(
  /<!-- LOCAL-OVERRIDE:start name="examples" -->[\s\S]*?<!-- LOCAL-OVERRIDE:end name="examples" -->/,
  `<!-- LOCAL-OVERRIDE:start name="examples" -->
- Consumer custom example 1
- Consumer custom example 2
<!-- LOCAL-OVERRIDE:end name="examples" -->`
);
fs.writeFileSync(consumerFile, edited);
// Bump framework version + re-sync so version-check doesn't short-circuit
fs.writeFileSync(path.join(fwRoot, '.claude', 'FRAMEWORK_VERSION'), '2.10.1\n');
fs.writeFileSync(path.join(fwRoot, 'manifest.json'), JSON.stringify({
  ...JSON.parse(fs.readFileSync(path.join(fwRoot, 'manifest.json'), 'utf8')),
  frameworkVersion: '2.10.1',
}, null, 2));
const out2 = runSync();
const fwNewPath = consumerFile + '.framework-new';
assert.ok(!fs.existsSync(fwNewPath), 'no .framework-new should be written for in-block edit; got: ' + out2);
const contentAfterReSync = fs.readFileSync(consumerFile, 'utf8');
assert.ok(contentAfterReSync.includes('Consumer custom example 1'), 'consumer in-block content preserved through sync');
assert.ok(contentAfterReSync.includes('Consumer custom example 2'), 'consumer in-block content preserved through sync');
pass('in-block edits preserved across framework version bump; no .framework-new');

// STEP 3 — operator edits OUTSIDE the override block; next sync SHOULD write .framework-new
const editedOutOfBlock = contentAfterReSync.replace(
  '## Footer',
  '## Footer\n\nConsumer added this line OUTSIDE any override block.'
);
fs.writeFileSync(consumerFile, editedOutOfBlock);
// Bump again so sync re-evaluates
fs.writeFileSync(path.join(fwRoot, '.claude', 'FRAMEWORK_VERSION'), '2.10.2\n');
fs.writeFileSync(path.join(fwRoot, 'manifest.json'), JSON.stringify({
  ...JSON.parse(fs.readFileSync(path.join(fwRoot, 'manifest.json'), 'utf8')),
  frameworkVersion: '2.10.2',
}, null, 2));
try { runSync(); } catch {
  // sync.js exits 1 when there are pre-existing .framework-new files; ignore that error
}
assert.ok(fs.existsSync(fwNewPath), 'out-of-block edit should produce .framework-new');
const fwNewContent = fs.readFileSync(fwNewPath, 'utf8');
assert.ok(fwNewContent.includes('Consumer custom example 1'), '.framework-new should still preserve in-block consumer content');
assert.ok(!fwNewContent.includes('Consumer added this line OUTSIDE'), '.framework-new should NOT include the out-of-block customisation (operator merges manually)');
pass('out-of-block edits produce .framework-new with in-block content preserved');

// Cleanup
fs.unlinkSync(fwNewPath);
fs.writeFileSync(consumerFile, contentAfterReSync); // revert the out-of-block edit

// STEP 4 — framework adds a NEW override block; consumer's old override preserved, new block keeps framework default
const fwV2 = `# Principles

Standard intro.

## Examples

<!-- LOCAL-OVERRIDE:start name="examples" -->
- Framework default example
<!-- LOCAL-OVERRIDE:end name="examples" -->

## New section

<!-- LOCAL-OVERRIDE:start name="new-slot" -->
Framework default for new slot.
<!-- LOCAL-OVERRIDE:end name="new-slot" -->

## Footer
`;
fs.writeFileSync(path.join(fwRoot, 'docs', 'principles.md'), fwV2);
fs.writeFileSync(path.join(fwRoot, '.claude', 'FRAMEWORK_VERSION'), '2.11.0\n');
fs.writeFileSync(path.join(fwRoot, 'manifest.json'), JSON.stringify({
  ...JSON.parse(fs.readFileSync(path.join(fwRoot, 'manifest.json'), 'utf8')),
  frameworkVersion: '2.11.0',
}, null, 2));
runSync();
const contentAfterNewSlot = fs.readFileSync(consumerFile, 'utf8');
assert.ok(contentAfterNewSlot.includes('Consumer custom example 1'), 'old consumer block content preserved when framework adds new block');
assert.ok(contentAfterNewSlot.includes('Framework default for new slot'), 'new framework block uses framework default since consumer has not filled it');
pass('framework can add new override blocks without disturbing consumer overrides');

// STEP 5 — ADR-0006 gate: the framework's own agent files must carry NO inline LOCAL-OVERRIDE
// blocks. Agents are framework-canonical; project-specific notes live in .claude/context/agent-context.md.
// (The mechanism above remains valid for NON-agent managed files — docs/principles.md exercised it.)
{
  // The exact uniform read-instruction. A bare 'agent-context.md' mention is NOT enough —
  // every agent also names the file in its footer pointer, so checking for the string would
  // pass an agent that lost the frontmatter-adjacent read-first instruction. Assert the exact
  // text AND that it is the first body line immediately after the frontmatter close.
  const READ_INSTRUCTION = '**Project context (read first).** If `.claude/context/agent-context.md` exists, read it before anything else';
  const agentsDir = path.join(realFwRoot, '.claude', 'agents');
  const offenders = [];
  const missingReadInstruction = [];
  for (const f of fs.readdirSync(agentsDir).filter(n => n.endsWith('.md'))) {
    const body = fs.readFileSync(path.join(agentsDir, f), 'utf8');
    // Match a REAL opening marker (start + whitespace + name=), not prose/grep examples that
    // mention the marker shape (e.g. validate-setup's own gate instruction).
    if (/LOCAL-OVERRIDE:start\s+name=/.test(body)) offenders.push(f);
    // Read-instruction must be present AND be the first non-blank body line after frontmatter.
    const lines = body.split('\n');
    let ok = false;
    if (lines[0].trim() === '---') {
      let end = -1;
      for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === '---') { end = i; break; } }
      if (end !== -1) {
        const firstBody = lines.slice(end + 1).find(l => l.trim() !== '') || '';
        ok = firstBody.startsWith('**Project context (read first).**') && body.includes(READ_INSTRUCTION);
      }
    }
    if (!ok) missingReadInstruction.push(f);
  }
  assert.deepStrictEqual(offenders, [], `framework agents must not declare LOCAL-OVERRIDE blocks (ADR-0006); offenders: ${offenders.join(', ')}`);
  assert.deepStrictEqual(missingReadInstruction, [], `every framework agent must carry the EXACT read-instruction as its first body line after frontmatter; missing/misplaced in: ${missingReadInstruction.join(', ')}`);
  pass('framework agents are LOCAL-OVERRIDE-free and carry the exact frontmatter read-instruction (ADR-0006)');
}

process.stdout.write('\nAll LOCAL-OVERRIDE e2e smoke tests passed.\n');
fs.rmSync(tmp, { recursive: true, force: true });

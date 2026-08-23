/**
 * install-codex-skill.test.mjs — proves the Codex run-final-uat package lands at
 * a consumer's `.agents/skills/run-final-uat/` and that the drift check works.
 * Run: npx vitest run scripts/uat/__tests__/install-codex-skill.test.mjs
 */

import { test, expect } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCodexSkill, checkDrift } from '../install-codex-skill.mjs';

const FRAMEWORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('installs the package at .agents/skills/run-final-uat with SKILL.md', () => {
  const target = mkdtempSync(path.join(os.tmpdir(), 'uat-consumer-'));
  const { dest, files } = installCodexSkill(target, FRAMEWORK_ROOT);
  expect(existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
  expect(existsSync(path.join(dest, 'agents', 'openai.yaml'))).toBe(true);
  expect(files.some((f) => f.startsWith('references/'))).toBe(true);
  expect(dest.replace(/\\/g, '/')).toContain('.agents/skills/run-final-uat');
});

test('a freshly installed copy reports no drift', () => {
  const target = mkdtempSync(path.join(os.tmpdir(), 'uat-consumer-'));
  installCodexSkill(target, FRAMEWORK_ROOT);
  const d = checkDrift(target, FRAMEWORK_ROOT);
  expect(d.drifted).toBe(false);
});

test('an edited installed copy is detected as drifted (no two independently edited copies)', () => {
  const target = mkdtempSync(path.join(os.tmpdir(), 'uat-consumer-'));
  const { dest } = installCodexSkill(target, FRAMEWORK_ROOT);
  const skill = path.join(dest, 'SKILL.md');
  writeFileSync(skill, readFileSync(skill, 'utf8') + '\nlocal edit that must be caught\n');
  const d = checkDrift(target, FRAMEWORK_ROOT);
  expect(d.drifted).toBe(true);
  expect(d.changed).toContain('SKILL.md');
});

// Run: node --test
// Covers the clodex skill-injection library helpers: frontmatter parsing,
// SKILL.md normalization (canonical name), and the plugin-scaffold builder.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseSkillFrontmatter, skillMd, buildSkillPlugin } = require('../skills-util');

test('parseSkillFrontmatter: splits frontmatter from body, strips quotes', () => {
  const { meta, body } = parseSkillFrontmatter(
    '---\nname: deploy\ndescription: "Ship the app"\n---\nRun the deploy script.');
  assert.strictEqual(meta.name, 'deploy');
  assert.strictEqual(meta.description, 'Ship the app');
  assert.strictEqual(body, 'Run the deploy script.');
});

test('parseSkillFrontmatter: no fence => all body, empty meta', () => {
  const { meta, body } = parseSkillFrontmatter('just instructions');
  assert.deepStrictEqual(meta, {});
  assert.strictEqual(body, 'just instructions');
});

test('skillMd: forces canonical name, preserves description + body', () => {
  const out = skillMd('deploy', '---\nname: wrong-name\ndescription: Ship it\n---\nBody here.');
  assert.match(out, /^---\nname: deploy\n/);
  assert.match(out, /description: Ship it/);
  assert.doesNotMatch(out, /wrong-name/);
  assert.match(out, /Body here\./);
});

test('skillMd: no frontmatter => wraps with name + stub description', () => {
  const out = skillMd('deploy', 'Just the instructions.');
  assert.match(out, /^---\nname: deploy\ndescription: deploy\n---\n/);
  assert.match(out, /Just the instructions\./);
});

test('buildSkillPlugin: scaffolds manifest + per-skill SKILL.md, skips unknown', () => {
  const lib = [
    { name: 'deploy', content: '---\ndescription: Ship it\n---\nDeploy steps.' },
    { name: 'audit', content: '---\ndescription: Audit\n---\nAudit steps.' },
  ];
  const out = buildSkillPlugin(['deploy', 'ghost'], lib);
  assert.strictEqual(out.manifest.name, 'clodex-skills');
  assert.strictEqual(out.skills.length, 1);
  assert.strictEqual(out.skills[0].name, 'deploy');
  assert.match(out.skills[0].skillMd, /name: deploy/);
});

test('buildSkillPlugin: empty / all-unknown => null', () => {
  assert.strictEqual(buildSkillPlugin([], []), null);
  assert.strictEqual(buildSkillPlugin(['x'], [{ name: 'y', content: '' }]), null);
});

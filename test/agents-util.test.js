// Run: node --test
// Covers the clodex subagent library helpers: frontmatter parsing (the YAML
// subset), the markdown->--agents transform, enabled-set assembly, and the
// built-in deny rules.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseAgentFrontmatter, agentDef, buildAgentsArg, denyAgentRules,
} = require('../agents-util');

test('parseAgentFrontmatter: splits frontmatter from body, strips quotes', () => {
  const { meta, body } = parseAgentFrontmatter(
    '---\nname: lean-explore\ndescription: "Fast read-only search"\ntools: Read, Grep, Glob\nmodel: haiku\n---\nYou are a focused explorer.\nReturn conclusions only.');
  assert.strictEqual(meta.name, 'lean-explore');
  assert.strictEqual(meta.description, 'Fast read-only search');
  assert.strictEqual(meta.tools, 'Read, Grep, Glob');
  assert.strictEqual(meta.model, 'haiku');
  assert.strictEqual(body, 'You are a focused explorer.\nReturn conclusions only.');
});

test('parseAgentFrontmatter: no fence => all body, empty meta', () => {
  const { meta, body } = parseAgentFrontmatter('just a prompt, no frontmatter');
  assert.deepStrictEqual(meta, {});
  assert.strictEqual(body, 'just a prompt, no frontmatter');
});

test('agentDef: lists become arrays, body becomes prompt, maxTurns coerced', () => {
  const def = agentDef(
    { description: 'd', model: 'sonnet', tools: 'Read, Bash', disallowedTools: 'Write',
      skills: 'a, b', maxTurns: '5', permissionMode: 'dontAsk', bogusField: 'x' },
    'the prompt');
  assert.deepStrictEqual(def, {
    description: 'd', prompt: 'the prompt', model: 'sonnet',
    tools: ['Read', 'Bash'], disallowedTools: ['Write'], skills: ['a', 'b'],
    permissionMode: 'dontAsk', maxTurns: 5,
  });
  assert.ok(!('bogusField' in def), 'unknown frontmatter fields are dropped');
});

test('agentDef: non-numeric maxTurns is ignored', () => {
  const def = agentDef({ maxTurns: 'lots' }, 'p');
  assert.ok(!('maxTurns' in def));
});

test('buildAgentsArg: assembles only enabled+present agents', () => {
  const lib = [
    { name: 'lean', meta: { description: 'l', tools: 'Read' }, body: 'pl' },
    { name: 'db', meta: { description: 'd', tools: 'Bash' }, body: 'pd' },
  ];
  const obj = buildAgentsArg(['lean', 'missing'], lib);
  assert.deepStrictEqual(Object.keys(obj), ['lean']);
  assert.deepStrictEqual(obj.lean, { description: 'l', prompt: 'pl', tools: ['Read'] });
});

test('buildAgentsArg: null when nothing enabled or nothing matches', () => {
  assert.strictEqual(buildAgentsArg([], [{ name: 'a', meta: {}, body: '' }]), null);
  assert.strictEqual(buildAgentsArg(['nope'], [{ name: 'a', meta: {}, body: '' }]), null);
  assert.strictEqual(buildAgentsArg(undefined, []), null);
});

test('denyAgentRules: wraps built-in names as Agent(...) deny rules', () => {
  assert.deepStrictEqual(
    denyAgentRules(['general-purpose', 'Explore']),
    ['Agent(general-purpose)', 'Agent(Explore)']);
  assert.deepStrictEqual(denyAgentRules([]), []);
  assert.deepStrictEqual(denyAgentRules(null), []);
});

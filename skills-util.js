// skills-util.js — pure helpers for the clodex skill-injection library.
//
// clodex stores user-authored skills as SKILL.md-style markdown-with-frontmatter
// files in ~/.clodex/skills/*.md. At spawn, the enabled subset is scaffolded
// into a session-only Claude Code *plugin* directory and injected via the CLI's
// `--plugin-dir` flag — a plugin's skills/ folder joins the always-on roster,
// while writing nothing into the user's repo or ~/.claude.
//
// Unlike subagents (inline `--agents <json>`), the CLI has no `--skills` flag:
// skills are filesystem/plugin-based, so a plugin scaffold is the only analog.
//
// Kept dependency-free (no electron, no fs) so it can be unit-tested under plain
// node, mirroring agents-util.js / proxy-util.js. The fs-backed library and the
// scaffold writer both live in main.js and feed parsed records in here.

// Parse a leading `---\n ... \n---` frontmatter block — the same deliberate
// YAML subset agents-util uses (one `key: value` per line, no nesting). Skills
// only need `name` + `description` as scalars. Everything after the closing
// fence is the body (the skill instructions). No fence => all body.
function parseSkillFrontmatter(content) {
  const text = String(content || '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim(), fm: '' };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[mm[1]] = v;
  }
  return { meta, body: m[2].trim(), fm: m[1] };
}

// Produce the SKILL.md text the CLI expects for one library record. The dir
// name is the canonical skill identity, so the emitted `name:` is forced to it
// (the user's authored name line, if any, is overwritten) — this keeps the
// skills/<name>/ directory and the frontmatter from ever drifting. The rest of
// the user's frontmatter (notably `description`, required for discovery) and the
// body pass through verbatim, so multi-line YAML they author survives.
function skillMd(name, rawContent) {
  const text = String(rawContent || '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    // No frontmatter authored: wrap the whole thing as the body under a minimal
    // header. Without a description the skill won't surface, so seed a stub.
    const body = text.trim();
    return `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;
  }
  // Drop any existing name line, then prepend the canonical one.
  const fmLines = m[1].split(/\r?\n/).filter((l) => !/^name:\s*/i.test(l));
  const fm = [`name: ${name}`, ...fmLines].join('\n');
  return `---\n${fm}\n---\n${m[2].replace(/^\r?\n/, '')}`;
}

// Build the plugin scaffold for a set of enabled skill names against a library
// list ([{ name, content }, ...]). Returns { manifest, skills:[{name, skillMd}] }
// or null when nothing valid is enabled (so the caller can skip --plugin-dir).
// `manifest` is the .claude-plugin/plugin.json object; each skill becomes
// skills/<name>/SKILL.md. Names no longer on disk are skipped silently.
function buildSkillPlugin(names, library, pluginName = 'clodex-skills') {
  if (!Array.isArray(names) || names.length === 0) return null;
  const byName = new Map((library || []).map((s) => [s.name, s]));
  const skills = [];
  for (const n of names) {
    const s = byName.get(n);
    if (!s) continue;
    skills.push({ name: n, skillMd: skillMd(n, s.content || s.raw || '') });
  }
  if (!skills.length) return null;
  const manifest = {
    name: pluginName,
    version: '0.0.0',
    description: 'clodex session-injected skills',
    author: { name: 'clodex' },
  };
  return { manifest, skills };
}

module.exports = { parseSkillFrontmatter, skillMd, buildSkillPlugin };

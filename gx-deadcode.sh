#!/bin/sh
# gx-deadcode — find top-level functions nothing can reach.  Run:  sh ./gx-deadcode.sh
#
# Source of truth: greencross-gx-theme/gx-deadcode.sh. Synced into spokes by gx-sync.sh.
#
# IT IS A SHELL SCRIPT WRAPPING NODE, AND THAT IS NOT A STYLE CHOICE. clasp pushes .js/.gs/.ts/.html/
# .json and ignores every other extension, so a root-level gx-deadcode.JS would be inside the push
# scope of every spoke whose rootDir is the repo root — and would ship as gx-deadcode.gs, where the
# node shebang is a parse error that fails the ENTIRE push, backend fix and all. serve.js did exactly
# that to sales on 2026-09-03, and inventory and sales each carry a hand-written .claspignore line
# naming serve.js to this day.
#
# This file was briefly written as gx-deadcode.js and would have been the SECOND root-level .js
# gx-sync ever placed — arming the same trap in the same two repos, and silently, because gx-sync's
# warning for it tests for the literal name "serve.js" rather than for the mechanism. Shipping it as
# .sh removes the whole class instead of adding a second special case to remember: a .sh file cannot
# enter a clasp push whatever any .claspignore says.
#
# Embedding the analyzer in a heredoc is the same pattern gx-preflight.sh uses for its python.
set -u
_tmp="$(mktemp "${TMPDIR:-/tmp}/gx-deadcode.XXXXXX")" || exit 1
trap 'rm -f "$_tmp"' EXIT INT TERM
cat > "$_tmp" <<'NODEEOF'
/* gx-deadcode — find top-level functions nothing can reach.  Run:  node gx-deadcode.js
 *
 * Source of truth: greencross-gx-theme/gx-deadcode.js. Synced into spokes by gx-sync.sh.
 *
 * WHY IT EXISTS. On 2026-09-12 SPIFF was found carrying the whole Calculator importer — eleven
 * functions, 235 lines — thirteen days after the button that called it was cut. It compiled, it
 * tested clean, and nothing could reach any of it. It was not inert either: its one dead reader of
 * a store short_code was load-bearing in a COMMENT, so a live decision elsewhere rested on a fact
 * about unreachable code. Dead code is not free; it resurfaces as a caveat somewhere else.
 *
 * A PERIODIC SWEEP, NOT A PUSH GATE, deliberately. Dead code accumulates over weeks, so a per-push
 * check is green almost every time — and the once it fires it is as likely to be a helper added one
 * commit before its caller as a real orphan. gx-preflight already makes the argument against itself:
 * "a hook that cries wolf on a clean tree gets --no-verify'd within a day". Run this when you are
 * looking for work, not when you are trying to ship.
 *
 * CONSERVATIVE ON PURPOSE — the failure that matters is deleting something LIVE:
 *   - a reference inside a STRING counts as alive. Trigger handlers are named in strings
 *     (ScriptApp.newTrigger('fn'), getHandlerFunction() === 'fn') and nowhere else.
 *   - a reference in HTML counts as alive (onclick="fn()").
 *   - a mention in a .md counts as alive. Loose on purpose: it can hide a documented orphan, which
 *     is the safe direction to be wrong in.
 *   - only COMMENTS do not count. A tombstone naming a function is not a caller.
 *   - a name with NO trailing underscore is reported SEPARATELY and never cascaded. Apps Script
 *     reaches those from a trigger, the Run menu, or google.script.run with no reference in source
 *     at all, so "unreferenced" says nothing about them. Letting them cascade once condemned four
 *     live Price Cards functions through a single run-once installer.
 *
 * THE TOKENIZER IS LOAD-BEARING. A naive comment/string stripper desynchronizes on a regex literal
 * containing a quote and swallows the rest of the file, after which every later declaration vanishes
 * and the verdict inverts. That exact failure reported norm_ and doPost as dead during the SPIFF
 * cleanup — norm_ had two live callers; doPost is an entry point Google calls by name. Both would
 * have been deleted on that evidence. Line alignment is asserted, because a stripper that eats
 * newlines reports every line number wrong.
 *
 * WHAT IT CANNOT DO. Top-level (column 0) declarations only — a nested helper is out of scope. It
 * reads source, so a function reached by a computed name is invisible. Treat the output as a list to
 * go and CHECK, never a list to go and delete: verify each by hand, and re-run afterwards, since a
 * removal orphans its own helpers in turn.
 *
 * PROVE IT BEFORE TRUSTING IT. Validated against greencross-spiff at 9964b5d^, where it reproduced
 * that cleanup's hand-verified list of eleven exactly — plus one orphan nobody had found.
 */
'use strict';
const fs = require('fs'), path = require('path');

/* Two line-aligned views of a source file:
     code — comments AND string/regex content blanked (for brace matching and declarations)
     refs — comments blanked, strings KEPT           (for counting references)
   Regex-vs-division is decided by the previous significant token, the way a parser does it. */
function views(src) {
  let code = '', refs = '', i = 0, prev = '';
  const n = src.length;
  const regexCanFollow = t => t === '' || /[({[,;:!&|?+\-*/%=~^<>]$/.test(t) ||
    /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(t);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { code += ' '; refs += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      code += '  '; refs += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { const e = src[i] === '\n' ? '\n' : ' '; code += e; refs += e; i++; }
      code += '  '; refs += '  '; i += 2; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; code += ' '; refs += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { code += '  '; refs += src[i] + (src[i + 1] || ''); i += 2; continue; }
        code += src[i] === '\n' ? '\n' : ' '; refs += src[i]; i++;
      }
      code += ' '; refs += (src[i] || ''); i++; prev = 'X'; continue;
    }
    if (c === '/' && regexCanFollow(prev)) {
      let j = i + 1, inClass = false, closed = false;
      while (j < n) {
        const e = src[j];
        if (e === '\\') { j += 2; continue; }
        if (e === '\n') break;
        if (e === '[') inClass = true; else if (e === ']') inClass = false;
        else if (e === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        let k = j + 1; while (k < n && /[gimsuy]/.test(src[k])) k++;
        code += ' '.repeat(k - i); refs += src.slice(i, k);
        i = k; prev = 'X'; continue;
      }
    }
    code += c; refs += c;
    if (!/\s/.test(c)) prev = (prev + c).slice(-12);
    i++;
  }
  return { code, refs };
}

/* In a monolith, blank everything outside an inline <script> so markup cannot look like code. */
function scriptsOnly(src) {
  const out = new Array(src.length).fill(' ');
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') out[i] = '\n';
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(src))) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    const start = m.index + m[0].indexOf(m[2], m[1].length);
    for (let k = 0; k < m[2].length; k++) out[start + k] = m[2][k];
  }
  return out.join('');
}

function scan(repo, files) {
  const decls = [];
  for (const f of files) {
    const abs = path.join(repo, f);
    if (!fs.existsSync(abs)) continue;
    const raw = fs.readFileSync(abs, 'utf8');
    const src = /\.html?$/i.test(f) ? scriptsOnly(raw) : raw;
    const v = views(src);
    if (v.code.split('\n').length !== src.split('\n').length)
      throw new Error('tokenizer changed the line count in ' + f + ' — every line number would be wrong');
    const lines = v.code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);   // column 0 only
      if (!m) continue;
      let depth = 0, started = false, end = i;
      outer: for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') { depth--; if (started && depth === 0) { end = j; break outer; } }
        }
      }
      decls.push({ name: m[1], file: f, line: i + 1, start: i, end });
    }
  }

  // Reference text: EVERY file in the repo, comments blanked, strings kept.
  const REF_EXT = /\.(js|gs|html?|json|sh|md)$/i;
  const SKIP_DIR = /(^|\/)(\.git|node_modules|design_handoff[^/]*)(\/|$)/;
  const refBlobs = [];
  (function walk(d) {
    for (const e of fs.readdirSync(path.join(repo, d), { withFileTypes: true })) {
      const rel = d ? d + '/' + e.name : e.name;
      if (SKIP_DIR.test('/' + rel)) continue;
      if (e.isDirectory()) { walk(rel); continue; }
      if (!REF_EXT.test(e.name)) continue;
      const raw = fs.readFileSync(path.join(repo, rel), 'utf8');
      if (/\.(md|json|sh)$/i.test(rel)) { refBlobs.push({ file: rel, text: raw }); continue; }
      try { refBlobs.push({ file: rel, text: views(raw).refs }); }
      catch (e2) { refBlobs.push({ file: rel, text: raw }); }
    }
  })('');

  const dead = new Set();
  function referencesOutside(name) {
    // \b is useless for a name containing `$` — it is not a word character, so `\b$$\b` matches
    // nothing and a live helper reads as dead. Use explicit non-identifier boundaries.
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp('(?<![\\w$])' + esc + '(?![\\w$])');
    for (const blob of refBlobs) {
      const lines = blob.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!pat.test(lines[i])) continue;
        const inSelfOrDead = decls.some(d => d.file === blob.file && i >= d.start && i <= d.end &&
          (d.name === name || dead.has(d.name)));
        if (!inSelfOrDead) return true;
      }
    }
    return false;
  }

  const unique = n => decls.filter(x => x.name === n).length === 1;
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of decls) {
      if (dead.has(d.name) || !d.name.endsWith('_') || !unique(d.name)) continue;
      if (!referencesOutside(d.name)) { dead.add(d.name); changed = true; }
    }
  }

  const size = d => d.end - d.start + 1;
  return {
    totalFunctions: decls.length,
    private_dead: decls.filter(d => dead.has(d.name))
      .map(d => ({ name: d.name, file: d.file, line: d.line, lines: size(d) })),
    entrypoint_suspects: decls.filter(d => !d.name.endsWith('_') && unique(d.name) && !referencesOutside(d.name))
      .map(d => ({ name: d.name, file: d.file, line: d.line, lines: size(d) })),
  };
}

// ── Which files does this repo own? Derived, never a typed list ────────────────────────────────
// A typed list rots silently: it goes stale the day a repo adds a .gs, and a scan that quietly
// stopped looking at a file prints the same "clean" as one that looked and found nothing.
const repo = process.cwd();

// Files fetched from gx-theme are not this app's code. Scanning them would report the theme's own
// helpers as dead in every spoke at once.
const SHARED = new Set([
  'serve.js', 'gx-deadcode.js', 'gx-dev.js', 'gx-client.js', 'gx-topnav.js', 'gx-avatar.js',
  'gx-avatar-picker.js', 'gx-session.js', 'gx-stores.js', 'gx-changelog.js', 'gx-bugreport.js',
  'gx-maintenance.js', 'gx-updatecheck.js',
]);

const owned = [];
for (const dir of ['', 'apps-script']) {
  const abs = dir ? path.join(repo, dir) : repo;
  if (!fs.existsSync(abs)) continue;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!e.isFile() || SHARED.has(e.name)) continue;
    const rel = dir ? dir + '/' + e.name : e.name;
    if (/\.gs$/i.test(e.name)) { owned.push(rel); continue; }
    if (!dir && /\.(js|html?)$/i.test(e.name)) owned.push(rel);
  }
}
if (!owned.length) {
  console.log('gx-deadcode: no source files here — run it from an app repo root.');
  process.exit(0);
}

const app = (() => { try { return fs.readFileSync(path.join(repo, '.gx_app'), 'utf8').trim(); }
                     catch (e) { return path.basename(repo); } })();
const r = scan(repo, owned);

console.log('gx-deadcode — ' + app + ': ' + r.totalFunctions + ' top-level functions in ' + owned.length + ' file(s)');

if (!r.private_dead.length) {
  console.log('  ✓ nothing unreachable');
} else {
  const total = r.private_dead.reduce((n, d) => n + d.lines, 0);
  console.log('  ' + r.private_dead.length + ' unreachable — ' + total + ' lines. Trailing _, so nothing outside this code can call them:');
  for (const d of r.private_dead.sort((a, b) => b.lines - a.lines))
    console.log('     ' + d.name.padEnd(30) + d.file + ':' + d.line + '  (' + d.lines + ' lines)');
  console.log('  Verify each by hand before deleting, then re-run — a removal orphans its own helpers.');
}

if (r.entrypoint_suspects.length) {
  console.log('  ' + r.entrypoint_suspects.length + ' unreferenced but NOT private (no trailing _). Usually fine —');
  console.log('     a trigger target, an editor Run-menu function, or google.script.run. Check, do not delete:');
  for (const d of r.entrypoint_suspects.sort((a, b) => b.lines - a.lines))
    console.log('     ' + d.name.padEnd(30) + d.file + ':' + d.line + '  (' + d.lines + ' lines)');
}

// Informational by design — see the note at the top about push gates.
process.exit(0);
NODEEOF
command -v node >/dev/null 2>&1 || { echo "gx-deadcode: node is not on PATH"; exit 1; }
node "$_tmp"

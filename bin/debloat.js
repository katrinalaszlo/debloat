#!/usr/bin/env node
// debloat — itemize what Claude Code loads into context before your prompt,
// and explain which instruction layers apply when it touches a specific file.
// Static scan of the same files Claude Code reads. Token counts are chars/4 estimates;
// reconcile against /context inside a live session.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const SKILLS_DIR = path.join(CLAUDE_DIR, "skills");
const DISABLED_DIR = path.join(CLAUDE_DIR, "skills-disabled");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "__pycache__", "target"]);

// Measured on Claude Code 2.1.215 via /context. Not statically derivable.
const BASE_ESTIMATES = [
  { label: "claude code system prompt", tokens: 6200 },
  { label: "built-in tool schemas", tokens: 4700 },
];

const est = (chars) => Math.round(chars / 4);
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
// End-truncate with an ellipsis so a cut identifier never reads as a different,
// still-plausible one (e.g. "setup-browser-cookies" -> "setup-browser-cookie").
const truncName = (s, max) => (s.length <= max ? s : s.slice(0, max - 1) + "…");

// Styling: TTY-only (or --color to force), respects NO_COLOR and --no-color.
// Styles wrap whole padded lines so ANSI codes never break column math.
const paint = (process.stdout.isTTY || process.argv.includes("--color")) &&
  !("NO_COLOR" in process.env) && !process.argv.includes("--no-color");
const styled = (code, t) => (paint ? `\x1b[${code}m${t}\x1b[0m` : t);
const bold = (t) => styled("1", t);
const dim = (t) => styled("2", t);
const accent = (t) => styled("1;36", t);
const warn = (t) => styled("33", t);
const green = (t) => styled("32", t);
const read = (p) => fs.readFileSync(p, "utf8");
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
// Canonical absolute path for dedup — resolves symlinks when the path exists.
const canon = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

const frontmatter = (file) => read(file).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
const headings = (file) =>
  [...read(file).matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim().toLowerCase().replace(/[^\w\s]/g, ""));

// --- args --------------------------------------------------------------------

const args = process.argv.slice(2);
const SUBCOMMANDS = new Set(["explain", "skills", "receipt"]);
const command = SUBCOMMANDS.has(args[0]) ? args[0] : "default";
const rest = command === "default" ? args : args.slice(1);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const budgetArg = rest.includes("--budget") ? rest[rest.indexOf("--budget") + 1] : null;
const budget = budgetArg === null ? null : parseInt(budgetArg, 10);
const positional = rest.filter((a) => !a.startsWith("--") && a !== budgetArg);
const cwd = path.resolve(command === "explain" ? "." : positional[0] || ".");

// --- shared collection ---------------------------------------------------------

function upChain(dir) {
  const chain = [];
  for (let d = dir; ; d = path.dirname(d)) {
    chain.unshift(d);
    if (d === path.dirname(d)) break;
  }
  return chain;
}

function collectImports(file, out) {
  for (const m of read(file).matchAll(/^@(\S+)/gm)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (exists(target)) out.push({ label: `@import ${m[1]}`, file: target, chars: read(target).length });
  }
}

// Always in context at startup, regardless of which file Claude touches.
function alwaysLoaded(projectDir) {
  const items = [];
  const add = (label, file) => exists(file) && items.push({ label, file, chars: read(file).length });

  add("CLAUDE.md (global)", path.join(CLAUDE_DIR, "CLAUDE.md"));
  const rulesDir = path.join(CLAUDE_DIR, "rules");
  if (exists(rulesDir))
    for (const f of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md")))
      add(`rules/${f} (global)`, path.join(rulesDir, f));

  const claudeMds = [];
  for (const dir of upChain(projectDir)) {
    const f = path.join(dir, "CLAUDE.md");
    if (dir !== HOME && exists(f)) {
      items.push({ label: `CLAUDE.md (${path.basename(dir) || "/"})`, file: f, chars: read(f).length });
      claudeMds.push(f);
    }
  }
  const before = items.length;
  for (const f of claudeMds) collectImports(f, items);
  const importedPaths = new Set(items.slice(before).map((i) => i.file));

  add("MEMORY.md (auto-memory index)", path.join(CLAUDE_DIR, "projects", projectDir.replaceAll(/[/.]/g, "-"), "memory", "MEMORY.md"));
  return { items, importedPaths };
}

// CLAUDE.md files in subdirectories: load only when Claude works with files there.
function nestedClaudeMds(projectDir, maxDepth = 4) {
  const found = [];
  (function walk(dir, depth) {
    if (depth > maxDepth) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const sub = path.join(dir, e.name);
      const f = path.join(sub, "CLAUDE.md");
      if (exists(f)) found.push({ dir: sub, file: f, chars: read(f).length });
      walk(sub, depth + 1);
    }
  })(projectDir, 0);
  return found;
}

function scanSkills(root, scope, items) {
  if (!exists(root)) return;
  let chars = 0, count = 0;
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, "SKILL.md");
    if (!exists(f)) continue;
    const { name, desc } = skillMeta(f, d);
    chars += name.length + desc.length + 4;
    count++;
  }
  if (count) items.push({ label: `skill listing, ${scope} (${count} skills)`, file: root, chars });
}

function skillMeta(file, fallbackName) {
  const fm = frontmatter(file);
  // description runs until the next top-level key (continuation lines are indented)
  let desc = "";
  const start = fm.search(/^description:/m);
  if (start >= 0) {
    const rest = fm.slice(start + "description:".length);
    const next = rest.search(/\n[\w-]+:\s/);
    desc = (next === -1 ? rest : rest.slice(0, next)).trim();
  }
  return { name: fm.match(/^name:\s*(.*)$/m)?.[1] ?? fallbackName, desc };
}

// Skills shipped by installed plugins are listed in context too.
function scanPluginSkills(items) {
  const manifest = path.join(CLAUDE_DIR, "plugins", "installed_plugins.json");
  if (!exists(manifest)) return;
  let chars = 0, count = 0;
  for (const entries of Object.values(JSON.parse(read(manifest)).plugins ?? {})) {
    for (const e of entries) {
      const skillsDir = path.join(e.installPath, "skills");
      if (!exists(skillsDir)) continue;
      for (const d of fs.readdirSync(skillsDir)) {
        const f = path.join(skillsDir, d, "SKILL.md");
        if (!exists(f)) continue;
        const { name, desc } = skillMeta(f, d);
        chars += name.length + desc.length + 4;
        count++;
      }
    }
  }
  if (count) items.push({ label: `skill listing, plugins (${count} skills)`, file: manifest, chars });
}

function scanAgents(root, scope, items) {
  if (!exists(root)) return;
  let chars = 0, count = 0;
  for (const f of fs.readdirSync(root).filter((f) => f.endsWith(".md"))) {
    chars += frontmatter(path.join(root, f)).length;
    count++;
  }
  if (count) items.push({ label: `agent listing, ${scope} (${count} agents)`, file: root, chars });
}

// --- skills: cost vs usage, reversible disable ---------------------------------

// Scan Claude Code session logs for skill invocations. Two invocation shapes:
//   Skill tool:     "skill":"<slug>"
//   slash command:  <command-name>/<slug></command-name>  (harness-injected)
// Returns Map key -> { count, last(ms) }. Timestamp from the line when present,
// else the session file's mtime, so "last used" is real, not just ever/never.
function scanSkillUsage() {
  const usage = new Map();
  const projects = path.join(CLAUDE_DIR, "projects");
  if (!exists(projects)) return usage;
  // The scan reads every session log and can take a few seconds; show a
  // heartbeat on stderr (kept off stdout so piped output stays clean).
  const showStatus = process.stderr.isTTY;
  if (showStatus) process.stderr.write("reading session history…\r");
  const bump = (key, ms) => {
    const cur = usage.get(key) ?? { count: 0, last: 0 };
    cur.count++;
    if (ms > cur.last) cur.last = ms;
    usage.set(key, cur);
  };
  const stack = [projects];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.name.endsWith(".jsonl")) continue;
      let txt, fileMs;
      try { txt = fs.readFileSync(p, "utf8"); fileMs = fs.statSync(p).mtimeMs; } catch { continue; }
      for (const line of txt.split("\n")) {
        if (!line.includes("skill") && !line.includes("command-name")) continue;
        const ts = line.match(/"timestamp":"([^"]+)"/);
        const ms = ts ? (Date.parse(ts[1]) || fileMs) : fileMs;
        for (const m of line.matchAll(/"skill":"([^"]+)"/g)) bump(m[1], ms);
        for (const m of line.matchAll(/<command-name>\/?([\w:-]+)<\/command-name>/g)) bump(m[1], ms);
      }
    }
  }
  if (showStatus) process.stderr.write("                        \r");
  return usage;
}

// One row per installed user skill: cost + real usage. Usage matches on the
// folder name OR the frontmatter `name:` (they can differ).
function skillRows() {
  const usage = scanSkillUsage();
  const rows = [];
  if (exists(SKILLS_DIR))
    for (const d of fs.readdirSync(SKILLS_DIR)) {
      const f = path.join(SKILLS_DIR, d, "SKILL.md");
      if (!exists(f)) continue;
      const { name, desc } = skillMeta(f, d);
      const u = usage.get(d) ?? usage.get(name);
      rows.push({ slug: d, tokens: est(name.length + desc.length + 4), count: u?.count ?? 0, last: u?.last ?? 0 });
    }
  return rows;
}

function fmtAgo(ms) {
  if (!ms) return "never";
  const d = Math.floor((Date.now() - ms) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// Move a skill between enabled/disabled. Never deletes; returns an error string
// or null on success. Disabling = mv to ~/.claude/skills-disabled/<slug>.
function moveSkill(slug, from, to) {
  const src = path.join(from, slug);
  const dst = path.join(to, slug);
  // lstat (not stat) so symlinked skills and dead links are detected as
  // present — following the link would misjudge existence and crash rename.
  const there = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  if (!there(src)) return `not found: ${slug}`;
  if (there(dst)) return `already there: ${slug}`;
  try {
    fs.mkdirSync(to, { recursive: true });
    fs.renameSync(src, dst);
  } catch (e) {
    return `couldn't move ${slug} (${e.code || e.message})`;
  }
  return null;
}

// Skills worth keeping even when never invoked — safety rails / guardrails that
// fire reactively, so "never used" is expected, not a reason to cut them.
const SAFETY_SKILLS = new Set([
  "git-safety", "security-expert", "security-review", "security-audit", "cso",
  "guard", "careful", "open-source-checker", "hallucination-audit", "drift-check",
  "codeql", "second-opinion",
]);
const isSafetyRail = (slug) => SAFETY_SKILLS.has(slug) || slug.includes("security");

// If a skill's SKILL.md symlinks OUT of its own folder, another tool owns it
// (gstack, a plugin, etc.) and invokes it via its own CLI — usage that never
// reaches Claude's session logs. So "never invoked" is unreliable for these;
// name the manager so the recommendation can exclude them instead of guessing.
function skillManager(slug) {
  const ownDir = path.join(SKILLS_DIR, slug);
  let real;
  try { real = fs.realpathSync(path.join(ownDir, "SKILL.md")); } catch { return null; }
  if (real.startsWith(ownDir + path.sep)) return null; // self-contained, Claude-native
  if (real.includes(`${path.sep}gstack${path.sep}`)) return "gstack";
  if (real.includes(`${path.sep}plugins${path.sep}`)) return "a plugin";
  return "another tool";
}

// Total tokens Claude Code loads at startup for a project dir — same basis as
// the receipt, so the skills bar is honest about the whole context.
function startupTotalTokens(projectDir) {
  const { items } = alwaysLoaded(projectDir);
  scanSkills(SKILLS_DIR, "user", items);
  const projSkills = path.join(projectDir, ".claude", "skills");
  if (canon(projSkills) !== canon(SKILLS_DIR)) scanSkills(projSkills, "project", items);
  scanPluginSkills(items);
  const userAgents = path.join(CLAUDE_DIR, "agents");
  scanAgents(userAgents, "user", items);
  const projAgents = path.join(projectDir, ".claude", "agents");
  if (canon(projAgents) !== canon(userAgents)) scanAgents(projAgents, "project", items);
  return BASE_ESTIMATES.reduce((s, b) => s + b.tokens, 0) + items.reduce((s, i) => s + est(i.chars), 0);
}

function renderSkillList(rows) {
  const W = 54;
  const never = rows.filter((r) => r.count === 0);
  const used = rows.filter((r) => r.count > 0);
  const tok = never.reduce((s, r) => s + r.tokens, 0);
  const row = (r) => " " + truncName(r.slug, 31).padEnd(32) + String(r.tokens).padStart(6) + "  " + fmtAgo(r.last);
  console.log();
  console.log(" SKILLS — startup cost vs actual usage (user scope)");
  console.log(" tokens = est. context each skill adds to EVERY session (chars÷4)");
  console.log(" " + "─".repeat(W));
  console.log(" " + "NEVER INVOKED — never run".padEnd(32) + "tokens".padStart(6) + "  last used");
  for (const r of never) console.log(row(r));
  if (used.length) {
    console.log(" " + "─".repeat(W));
    console.log(" " + "ACTIVELY USED — keep".padEnd(32) + "tokens".padStart(6) + "  last used");
    for (const r of used) console.log(row(r));
  }
  console.log(" " + "─".repeat(W));
  console.log(` ${never.length}/${rows.length} never invoked · ~${fmt(tok)} tokens off every session if cut`);
  console.log(" note: some never-run skills are safety rails you may want to keep — you decide");
  console.log(" disable (reversible):  debloat skills --disable <name> [<name>...]");
  console.log(" restore any time:      debloat skills --enable <name>");
  console.log();
}

function skillsCommand() {
  if (flags.has("--enable")) {
    for (const slug of positional) console.log(moveSkill(slug, DISABLED_DIR, SKILLS_DIR) ?? `  enabled  ${slug}`);
    return;
  }
  if (flags.has("--disable")) {
    const rows = skillRows();
    let reclaimed = 0;
    for (const slug of positional) {
      const err = moveSkill(slug, SKILLS_DIR, DISABLED_DIR);
      if (err) { console.log(err); continue; }
      reclaimed += rows.find((r) => r.slug === slug)?.tokens ?? 0;
      console.log(`  disabled  ${slug}`);
    }
    if (reclaimed) console.log(`\n  ~${reclaimed} tokens off every session · restore: debloat skills --enable <name>`);
    return;
  }

  const rows = skillRows().sort((a, b) => (a.count > 0) - (b.count > 0) || b.tokens - a.tokens);

  // Default is the predictable printed list. The interactive checklist is
  // opt-in via --pick, so `skills` never surprises you by prompting (or by
  // silently printing when there's no keyboard, e.g. run through an agent).
  if (!flags.has("--pick")) {
    renderSkillList(rows);
    return;
  }
  // Three honest buckets, then one yes/no on only the confident set. No cursor
  // TUI — a single-line prompt is robust across every terminal.
  //   rec    = never invoked AND Claude-native — confidently dead
  //   unsure = never invoked in Claude, but another tool runs it (gstack etc.)
  //            so absence here proves nothing — YOUR call
  //   kept   = safety rails that fire on their own
  const never = rows.filter((r) => r.count === 0);
  const rec = [], unsure = [], kept = [];
  for (const r of never) {
    if (isSafetyRail(r.slug)) { kept.push(r); continue; }
    const mgr = skillManager(r.slug);
    if (mgr) { r.mgr = mgr; unsure.push(r); } else rec.push(r);
  }
  rec.sort((a, b) => b.tokens - a.tokens);
  unsure.sort((a, b) => b.tokens - a.tokens);
  // Nothing to recommend is a WIN, not a bare list — fall through to the
  // designed "you're already lean" state below instead of dumping renderSkillList.

  const color = process.stdout.isTTY;
  const red = (s) => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const yellow = (s) => (color ? `\x1b[33m${s}\x1b[0m` : s);
  const green = (s) => (color ? `\x1b[32m${s}\x1b[0m` : s);
  const CELL = 27; // 20-char name + space + 4-char token + 2-space gutter
  const cols = Math.max(1, Math.floor(((process.stdout.columns || 80) - 3) / CELL));
  const cell = (r) => truncName(r.slug, 20).padEnd(21) + dim(String(r.tokens).padStart(4) + " tok");
  const grid = (list) => { for (let i = 0; i < list.length; i += cols) console.log("   " + list.slice(i, i + cols).map(cell).join("  ")); };
  const recTok = rec.reduce((s, r) => s + r.tokens, 0);

  // Burn headline: bars against the real startup total, with a distinct row
  // for "also cut the your-call bucket" so each choice's savings is visible.
  const unsureTok = unsure.reduce((s, r) => s + r.tokens, 0);
  const total = startupTotalTokens(process.cwd());
  if (rec.length) {
    const BW = 26;
    const bar = (t) => "█".repeat(t === 0 ? 0 : Math.max(1, Math.round((t / total) * BW))).padEnd(BW);
    const lbl = (s) => "   " + s.padEnd(16);
    console.log();
    console.log(" " + red("⚡ " + bold(fmt(recTok) + " tokens")) + ` loaded every session on ${rec.length} skills you've never run`);
    console.log();
    console.log(lbl("now") + "█".repeat(BW) + "  " + bold(fmt(total)));
    console.log(lbl("after confident") + red(bar(total - recTok)) + "  " + fmt(total - recTok) + red(`  −${fmt(recTok)}`));
    if (unsure.length)
      console.log(lbl("after all") + yellow(bar(total - recTok - unsureTok)) + "  " + fmt(total - recTok - unsureTok) + yellow(`  −${fmt(recTok + unsureTok)} incl. your-call`));
    console.log();
    console.log(dim(` these ${rec.length} will be disabled — never run · number = tokens each · reversible:`));
    grid(rec);
  }

  // The important bucket: skills the tool can't judge, so the human decides.
  if (unsure.length) {
    const mgrs = [...new Set(unsure.map((r) => r.mgr))].join(" / ");
    console.log();
    console.log(" " + yellow("? YOUR CALL") + ` — ${unsure.length} never showed up in Claude's logs, but ${mgrs} runs them`);
    console.log(dim("   its own way, so I can't tell if you use them. Disable only the ones you don't:"));
    grid(unsure);
    console.log(dim("   disable any: debloat skills --disable <name>"));
  }

  if (kept.length) {
    console.log();
    console.log(dim(` keeping ${kept.length} safety rails (never used, but fire on their own): ` + kept.map((r) => r.slug).join(", ")));
  }
  console.log();

  if (!rec.length) {
    // Nothing to cut is a WIN — celebrate it like one, don't mumble it.
    const W = 39;
    const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
    const ctr = (s) => { const p = Math.max(0, W - vlen(s)); const l = Math.floor(p / 2); return " ".repeat(l) + s + " ".repeat(p - l); };
    const row = (s = "") => console.log("  │" + ctr(s) + "│");
    console.log();
    console.log("  " + ctr(bold(green("🎉  NICE — ALL CLEAN"))));
    console.log("  ┌" + "─".repeat(W) + "┐");
    row();
    row(green(bold("you keep a tidy context")));
    row(dim("every skill here earns its place"));
    row();
    row(bold(fmt(total)) + dim(" tokens loaded · nothing wasted"));
    row();
    console.log("  └" + "─".repeat(W) + "┘");
    if (unsure.length) console.log("  " + dim(`   ${unsure.length} gstack skills are yours to cut by name — your call`));
    console.log("  " + dim("   ✨ ") + accent("npx debloat"));
    console.log();
    return;
  }

  if (!process.stdin.isTTY) {
    console.log(" not an interactive terminal — apply the confident cut with:");
    console.log(`   debloat skills --disable ${rec.map((r) => r.slug).join(" ")}`);
    console.log();
    return;
  }

  // Razzle-dazzle success — the shareable "look what I just did" moment. Hero
  // is the win; sparkles + the npx footer so a screenshot recruits the next user.
  const celebrate = (n, reclaimed) => {
    const after = total - reclaimed;
    const pct = Math.round((reclaimed / total) * 100);
    const W = 39;
    const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
    const ctr = (s) => { const p = Math.max(0, W - vlen(s)); const l = Math.floor(p / 2); return " ".repeat(l) + s + " ".repeat(p - l); };
    const row = (s = "") => console.log("  │" + ctr(s) + "│");
    console.log();
    console.log("  " + ctr(bold("✨  you just trimmed  ✨")));
    console.log("  ┌" + "─".repeat(W) + "┐");
    row();
    row(green(bold(`−${fmt(reclaimed)} tokens`)));
    row(dim("every session"));
    row();
    row(fmt(total) + dim("  →  ") + bold(fmt(after)) + dim(`   ·   −${pct}%`));
    row(dim(`${n} skills cut · reversible`));
    row();
    console.log("  └" + "─".repeat(W) + "┘");
    console.log("  " + dim("   restore: skills --enable <name>  ·  ") + accent("npx debloat"));
    console.log();
  };

  const applyAndCelebrate = (list) => {
    let n = 0, reclaimed = 0;
    const failed = [];
    for (const r of list) {
      const err = moveSkill(r.slug, SKILLS_DIR, DISABLED_DIR);
      if (err) { failed.push(r.slug); continue; }
      n++;
      reclaimed += r.tokens;
    }
    celebrate(n, reclaimed);
    if (failed.length) console.log(dim(`  (skipped ${failed.length}: ${failed.join(", ")})\n`));
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (unsure.length) {
    // Three options — the "all" path is why the third bar exists.
    rl.question(` disable   ${bold("[1]")} confident ${red("−" + fmt(recTok))}    ${bold("[2]")} all incl. your-call ${yellow("−" + fmt(recTok + unsureTok))}    ${bold("[3]")} nothing   › `, (ans) => {
      rl.close();
      const a = ans.trim();
      if (a === "1") applyAndCelebrate(rec);
      else if (a === "2") applyAndCelebrate(rec.concat(unsure));
      else console.log(" no changes. or cut specific ones: debloat skills --disable <name>\n");
    });
  } else {
    rl.question(` disable the ${rec.length} confident? [y/N]  `, (ans) => {
      rl.close();
      if (!/^y(es)?$/i.test(ans.trim())) { console.log(" no changes. cut only some: debloat skills --disable <name>\n"); return; }
      applyAndCelebrate(rec);
    });
  }
}

// --- receipt -------------------------------------------------------------------

function receipt() {
  const notes = [];
  const { items, importedPaths } = alwaysLoaded(cwd);
  if (!items.some((i) => i.label.startsWith("MEMORY.md"))) notes.push("no auto-memory found for this project path");
  // When cwd is HOME, the project-scope dirs resolve to the same path as the
  // user-scope dirs — count each directory once, keyed by canonical path.
  const userSkills = path.join(CLAUDE_DIR, "skills");
  const projSkills = path.join(cwd, ".claude", "skills");
  const userAgents = path.join(CLAUDE_DIR, "agents");
  const projAgents = path.join(cwd, ".claude", "agents");
  scanSkills(userSkills, "user", items);
  if (canon(projSkills) !== canon(userSkills)) scanSkills(projSkills, "project", items);
  scanPluginSkills(items);
  scanAgents(userAgents, "user", items);
  if (canon(projAgents) !== canon(userAgents)) scanAgents(projAgents, "project", items);

  const conditional = nestedClaudeMds(cwd);

  const onDemand = [];
  try {
    const cfg = JSON.parse(read(path.join(HOME, ".claude.json")));
    const servers = { ...cfg.mcpServers, ...(cfg.projects?.[cwd]?.mcpServers ?? {}) };
    if (exists(path.join(cwd, ".mcp.json")))
      Object.assign(servers, JSON.parse(read(path.join(cwd, ".mcp.json"))).mcpServers ?? {});
    const names = Object.keys(servers);
    if (names.length) onDemand.push(`MCP, loads on use: ${names.join(", ")}`);
  } catch { /* no ~/.claude.json */ }

  const deadWeight = [];
  for (const dir of upChain(cwd)) {
    for (const [name, why] of [
      ["AGENTS.md", "ignored unless @imported from CLAUDE.md"],
      [".cursorrules", "Cursor's file — Claude Code ignores it"],
      ["GEMINI.md", "Gemini CLI's file — Claude Code ignores it"],
      [".github/copilot-instructions.md", "Copilot's file — Claude Code ignores it"],
    ]) {
      const f = path.join(dir, name);
      if (exists(f) && !importedPaths.has(f)) deadWeight.push({ file: f, chars: read(f).length, why });
    }
  }

  const yourTokens = items.reduce((s, i) => s + est(i.chars), 0);
  const baseTokens = BASE_ESTIMATES.reduce((s, b) => s + b.tokens, 0);
  const total = yourTokens + baseTokens;

  if (flags.has("--json")) {
    const artifact = {
      schema: "debloat/v0",
      tool: "claude-code",
      generatedAt: new Date().toISOString(),
      cwd,
      base: BASE_ESTIMATES,
      items: items.map((i) => ({ ...i, tokensEst: est(i.chars) })),
      conditional: conditional.map((c) => ({ ...c, tokensEst: est(c.chars) })),
      deadWeight,
      onDemand,
      totals: { yoursEst: yourTokens, baseEst: baseTokens, totalEst: total },
      notes,
    };
    const out = path.join(cwd, "debloat.json");
    fs.writeFileSync(out, JSON.stringify(artifact, null, 2));
    console.log(`wrote ${out}`);
  } else {
    const W = 50;
    // Middle-truncate labels so long paths never collide with the number column.
    const trunc = (l, r) => {
      const max = W - r.length - 3;
      if (l.length <= max) return l;
      const keep = max - 1, head = Math.ceil(keep * 0.4), tail = keep - head;
      return l.slice(0, head) + "…" + l.slice(l.length - tail);
    };
    const pad = (l, r = "") => " " + trunc(l, r).padEnd(W - r.length - 1) + r;
    const line = (l, r = "") => console.log(pad(l, r));
    const lineS = (fn, l, r = "") => console.log(fn(pad(l, r)));
    console.log();
    console.log(" " + styled("31", "⚡ " + bold(fmt(total) + " tokens")) + " loaded every session before your first word");
    lineS(dim, `claude code · ${path.basename(cwd)} · ${new Date().toLocaleString("sv-SE").slice(0, 16)}`);
    console.log();
    // Four category bars in the trimmer's language: solid █, scaled to the total.
    const cats = { base: baseTokens, instructions: 0, memory: 0, skills: 0 };
    for (const i of items) {
      const t = est(i.chars);
      if (i.label.startsWith("MEMORY.md")) cats.memory += t;
      else if (i.label.startsWith("skill listing") || i.label.startsWith("agent listing")) cats.skills += t;
      else cats.instructions += t;
    }
    const BW = 26;
    const cbar = (t) => "█".repeat(t === 0 ? 0 : Math.max(1, Math.round((t / total) * BW))).padEnd(BW);
    const crow = (label, t, paintFn, approx = "") =>
      console.log("   " + label.padEnd(18) + (paintFn ? paintFn(cbar(t)) : cbar(t)) + "  " + (approx + fmt(t)).padStart(6));
    crow("claude code base", cats.base, dim, "~");
    crow("instructions", cats.instructions, null);
    crow("memory", cats.memory, null);
    crow("skills + agents", cats.skills, (x) => styled("31", x));
    if (flags.has("--all")) {
      console.log();
      lineS(dim, "DETAIL", "tokens*");
      for (const b of BASE_ESTIMATES) line("  " + b.label, "~" + fmt(b.tokens));
      for (const i of items) line("  " + i.label, fmt(est(i.chars)));
    }
    const skillsCost = items.filter((i) => i.label.startsWith("skill listing")).reduce((s, i) => s + est(i.chars), 0);
    if (conditional.length) {
      console.log();
      const sortedC = [...conditional].sort((a, b) => b.chars - a.chars);
      const shown = flags.has("--all") ? sortedC : sortedC.slice(0, 5);
      const restCount = conditional.length - shown.length;
      line(`CONDITIONAL — loads when Claude works there`);
      for (const c of shown) line("  " + path.relative(cwd, c.file), fmt(est(c.chars)));
      if (restCount > 0) {
        const restTokens = conditional.reduce((s, c) => s + est(c.chars), 0) -
          shown.reduce((s, c) => s + est(c.chars), 0);
        lineS(dim, `  … ${restCount} more`, fmt(restTokens));
      }
    }
    if (deadWeight.length) {
      console.log();
      lineS(warn, "DEAD WEIGHT — on disk, NOT loaded");
      for (const d of deadWeight) {
        line("  " + path.relative(cwd, d.file), fmt(d.chars) + " chars");
        lineS(dim, "    " + d.why);
      }
    }
    if (onDemand.length) {
      console.log();
      for (const o of onDemand) line(o);
    }
    // Close in the box — the receipt's shareable unit, pointing at the trimmer.
    // (Emoji stays outside boxes: double-width glyphs shear the │ borders.)
    const CTX = 200000;
    const pct = Math.round((total / CTX) * 100);
    const BXW = 39;
    const vlen = (x) => x.replace(/\x1b\[[0-9;]*m/g, "").length;
    const ctr = (x) => { const p = Math.max(0, BXW - vlen(x)); const l = Math.floor(p / 2); return " ".repeat(l) + x + " ".repeat(p - l); };
    const brow = (x = "") => console.log("  │" + ctr(x) + "│");
    console.log();
    console.log("  ┌" + "─".repeat(BXW) + "┐");
    brow();
    brow(bold(`~${fmt(total)} tokens`) + dim(`  ·  ${pct}% of a 200k window`));
    brow();
    if (skillsCost > 3000) {
      brow(styled("31", bold(`~${fmt(skillsCost)} of it is skill listings`)));
      brow("trim the unused: " + accent("npx debloat"));
    } else {
      brow(green(bold("lean setup")));
      brow(dim("nothing obvious left to trim"));
    }
    brow();
    console.log("  └" + "─".repeat(BXW) + "┘");
    for (const n of notes) lineS(dim, "  note: " + n);
    lineS(dim, "  * chars÷4 estimate · reconcile with /context");
    console.log();
  }

  if (budget !== null && total > budget) {
    console.error(`over budget: ~${total} tokens > ${budget}`);
    process.exit(1);
  }
}

// --- explain -------------------------------------------------------------------

function explain(targetArg) {
  const target = path.resolve(targetArg);
  if (!exists(target)) {
    console.error(`no such file: ${target}`);
    process.exit(1);
  }
  const projectDir = cwd;
  const targetDir = fs.statSync(target).isDirectory() ? target : path.dirname(target);

  const { items: base } = alwaysLoaded(projectDir);
  const layers = base
    .filter((i) => !i.label.startsWith("MEMORY.md"))
    .map((i) => ({ ...i, when: "always (startup)" }));

  // Nested CLAUDE.md between project root and the target file
  if (targetDir.startsWith(projectDir)) {
    let dir = projectDir;
    for (const seg of path.relative(projectDir, targetDir).split(path.sep).filter(Boolean)) {
      dir = path.join(dir, seg);
      const f = path.join(dir, "CLAUDE.md");
      if (exists(f)) {
        layers.push({ label: `CLAUDE.md (${path.relative(projectDir, dir)})`, file: f, chars: read(f).length, when: "when Claude works in this directory" });
        collectImports(f, layers);
      }
    }
  }

  // Overlapping headings across layers — candidate conflicts, honestly labeled
  const seen = new Map();
  for (const l of layers)
    for (const h of new Set(headings(l.file)))
      seen.set(h, [...(seen.get(h) ?? []), path.relative(projectDir, l.file) || l.file]);
  const overlaps = [...seen].filter(([, files]) => files.length > 1);

  const total = layers.reduce((s, l) => s + est(l.chars), 0);

  if (flags.has("--json")) {
    console.log(JSON.stringify({
      schema: "debloat-explain/v0",
      target,
      layers: layers.map((l) => ({ ...l, tokensEst: est(l.chars) })),
      overlaps: overlaps.map(([heading, files]) => ({ heading, files })),
      totalEst: total,
    }, null, 2));
    return;
  }

  console.log();
  console.log(` ${path.relative(projectDir, target) || target}`);
  console.log(` inherits ${layers.length} instruction layers (~${fmt(total)} tokens est)`);
  console.log();
  layers.forEach((l, i) => {
    console.log(` ${i + 1}. ${l.label}  [${fmt(est(l.chars))}]`);
    console.log(`    ${l.when ?? "always (startup)"}`);
  });
  if (overlaps.length) {
    console.log();
    console.log(" OVERLAPPING SECTIONS — same heading in multiple layers,");
    console.log(" all in context at once; review for contradictions:");
    for (const [heading, files] of overlaps) console.log(`   "${heading}" — ${files.join(", ")}`);
  }
  console.log();
  console.log(" note: Claude Code loads all applicable layers simultaneously.");
  console.log(" There is no enforced precedence — nearer files win by convention only.");
  console.log();
}

// Default: on a real keyboard, land in the trimmer — the screen people share.
// Anything machine-shaped (piped, --json, --budget, no TTY) gets the static
// receipt, never a prompt. The full bill stays one word away: `receipt`.
const machineShaped = flags.has("--json") || budget !== null ||
  !process.stdout.isTTY || !process.stdin.isTTY;
command === "explain" ? explain(positional[0] ?? ".")
  : command === "skills" ? skillsCommand()
  : command === "receipt" ? receipt()
  : machineShaped ? receipt()
  : (flags.add("--pick"), skillsCommand());

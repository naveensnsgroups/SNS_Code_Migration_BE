// Lazy-loads every skill directory's skill.md once, caches for the process
// lifetime (these are static files, not session data — re-reading from disk
// on every generation turn would be wasteful I/O), and resolves
// targetStack.framework to a matching skill by exact/alias lookup — no
// semantic inference, no agent-driven discovery, this is a deterministic
// lookup because the caller already knows exactly what it's asking for.
//
// Layout: framework-skills/<framework>/skill.md — one directory per skill,
// mirroring the real Claude Skill convention (skill-name/SKILL.md), which
// also leaves room to bundle additional resources alongside a skill later.
import fs   from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { FrameworkSkill } from './types.js';
import { loadSkillFile } from './loader.js';

const SKILLS_DIR = path.dirname(fileURLToPath(import.meta.url));

let cache: Map<string, FrameworkSkill> | null = null; // alias (lowercased) -> skill

async function buildCache(): Promise<Map<string, FrameworkSkill>> {
  const map = new Map<string, FrameworkSkill>();
  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  const skillDirs = entries.filter(e => e.isDirectory());

  for (const dir of skillDirs) {
    const skillPath = path.join(SKILLS_DIR, dir.name, 'skill.md');
    if (!(await fs.pathExists(skillPath))) {
      console.warn(`[framework-skills] ${dir.name}/ has no skill.md — skipping.`);
      continue;
    }
    const skill = await loadSkillFile(skillPath, msg => console.warn(`[framework-skills] ${msg}`));
    if (!skill) continue;

    for (const alias of skill.frameworkNames) {
      const key = alias.trim().toLowerCase();
      if (!key) continue;
      const existing = map.get(key);
      if (existing) {
        console.warn(
          `[framework-skills] alias "${alias}" in ${skill.sourceFile} collides with an already-registered ` +
          `skill from ${existing.sourceFile} — keeping the first one registered.`
        );
        continue;
      }
      map.set(key, skill);
    }
  }
  return map;
}

export async function resolveFrameworkSkill(frameworkName: string): Promise<FrameworkSkill | null> {
  if (!frameworkName) return null;
  if (!cache) cache = await buildCache();

  const normalized = frameworkName.trim().toLowerCase();
  // Exact key match first, then substring containment (so "Fastapi" from a
  // dropdown matches alias "fastapi", and "FastAPI framework" would too).
  if (cache.has(normalized)) return cache.get(normalized)!;
  for (const [alias, skill] of cache) {
    if (normalized.includes(alias)) return skill;
  }
  return null;
}

// Every registered skill, deduplicated (the alias->skill cache map has one
// entry per ALIAS, so a skill with 3 aliases would otherwise appear 3 times)
// — used by the AI Config → Skills tab to list what's actually available.
export async function listAllSkills(): Promise<FrameworkSkill[]> {
  if (!cache) cache = await buildCache();
  const seen = new Set<string>();
  const skills: FrameworkSkill[] = [];
  for (const skill of cache.values()) {
    if (seen.has(skill.sourceFile)) continue;
    seen.add(skill.sourceFile);
    skills.push(skill);
  }
  return skills;
}

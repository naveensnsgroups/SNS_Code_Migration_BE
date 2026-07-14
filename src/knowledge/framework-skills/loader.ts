// Parses a framework-skill .md file (frontmatter + 5 fixed sections, see
// fastapi.md for the reference shape) into a FrameworkSkill. A malformed file
// (missing/misnamed section) is treated the same as "no skill matched" — never
// silently injected with a hole in it — the caller gets null plus a specific
// warning naming what was wrong, via onWarn.
import fs from 'fs-extra';
import matter from 'gray-matter';
import { FrameworkSkill, ScaffoldingFile } from './types.js';

type WarnFn = (message: string) => void;

const REQUIRED_SECTIONS = [
  'Folder Layout',
  'Router Pattern',
  'Dependency Injection Pattern',
  'Async Conventions',
  'Required Scaffolding',
] as const;

// Splits the markdown body on "## " (top-level) headings only — the "### "
// (three-hash) scaffolding sub-headings inside "Required Scaffolding" are a
// different heading level and never false-trigger a split here.
function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const matches = [...body.matchAll(/^##\s+(.+)$/gm)];
  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim();
    const start   = matches[i].index! + matches[i][0].length;
    const end     = i + 1 < matches.length ? matches[i + 1].index! : body.length;
    sections[heading] = body.slice(start, end).trim();
  }
  return sections;
}

// Parses the "Required Scaffolding" section's own nested "### <id> (order: first|last)"
// sub-entries, each followed by fixed "Target:" / "Purpose:" / "Brief:" lines.
function parseScaffolding(sectionText: string): ScaffoldingFile[] {
  const entries: ScaffoldingFile[] = [];
  const matches = [...sectionText.matchAll(/^###\s+(.+)$/gm)];

  for (let i = 0; i < matches.length; i++) {
    const headingLine = matches[i][1].trim();
    const start = matches[i].index! + matches[i][0].length;
    const end   = i + 1 < matches.length ? matches[i + 1].index! : sectionText.length;
    const block = sectionText.slice(start, end);

    const headingMatch = headingLine.match(/^(\S+)\s*\(order:\s*(first|last)\)$/i);
    if (!headingMatch) continue; // malformed scaffolding heading — skip this entry, not the whole skill

    const [, id, order] = headingMatch;
    const target  = block.match(/^Target:\s*`?([^\n`]+)`?/m)?.[1]?.trim();
    const purpose = block.match(/^Purpose:\s*(.+)$/m)?.[1]?.trim();
    // Brief is a "Brief: >" YAML-style folded block — everything after that line,
    // trimmed, up to the end of this entry's block.
    const briefStart = block.search(/^Brief:\s*>?\s*$/m);
    const brief = briefStart >= 0
      ? block.slice(block.indexOf('\n', briefStart) + 1).trim()
      : undefined;

    if (!target || !purpose || !brief) continue; // incomplete entry — skip it, not the whole skill

    entries.push({
      id, order: order.toLowerCase() as 'first' | 'last',
      targetFileHint: target, purpose, generationBrief: brief,
    });
  }
  return entries;
}

export async function loadSkillFile(filePath: string, onWarn?: WarnFn): Promise<FrameworkSkill | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    onWarn?.(`Skill file ${filePath} could not be read: ${err.message}`);
    return null;
  }

  const { data: frontmatter, content: body } = matter(raw);
  const frameworkNames: unknown = frontmatter.aliases;
  if (!Array.isArray(frameworkNames) || frameworkNames.length === 0 || typeof frontmatter.framework !== 'string') {
    onWarn?.(`Skill file ${filePath} is missing required frontmatter ("framework" and/or "aliases") — skipping.`);
    return null;
  }

  const sections = parseSections(body);
  for (const required of REQUIRED_SECTIONS) {
    if (!sections[required]?.trim()) {
      onWarn?.(`Skill file ${filePath} is missing required section "${required}" — skipping, falling back to general LLM knowledge for this framework.`);
      return null;
    }
  }

  const scaffolding = parseScaffolding(sections['Required Scaffolding']);
  if (scaffolding.length === 0) {
    onWarn?.(`Skill file ${filePath} has a "Required Scaffolding" section but no valid scaffolding entries were parsed from it — skipping.`);
    return null;
  }

  return {
    frameworkNames: frameworkNames.map(String),
    language:  typeof frontmatter.language === 'string' ? frontmatter.language : '',
    version:   typeof frontmatter.version === 'number' ? frontmatter.version : 1,
    folderLayout:     sections['Folder Layout'],
    routerPattern:    sections['Router Pattern'],
    diPattern:        sections['Dependency Injection Pattern'],
    asyncConventions: sections['Async Conventions'],
    scaffolding,
    sourceFile: filePath,
  };
}

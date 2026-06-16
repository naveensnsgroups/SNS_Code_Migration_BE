// =============================================================================
//  section-assembler.ts — Stage 5: Section File Assembler (No LLM)
//
//  Reads all 26 section files from _analysis/sections/
//  and assembles them into a single Stage1_Analysis.md file.
//
//  No LLM is used. Pure TypeScript file I/O.
// =============================================================================

import fs from 'fs-extra';
import path from 'path';

/** The 26 section file names (padded to 2 digits). */
const SECTION_NUMBERS = Array.from({ length: 26 }, (_, i) => i + 1);

const SECTION_NAMES: Record<number, string> = {
  1: 'Project Identity',
  2: 'Architecture Overview',
  3: 'Source Structure',
  4: 'File Classification',
  5: 'Domain Models',
  6: 'Dependencies',
  7: 'Functions Master Catalog',
  8: 'Function Behaviors',
  9: 'Business Rules',
  10: 'API Contracts',
  11: 'Security & Permissions',
  12: 'Middleware Execution Order',
  13: 'Database Operations',
  14: 'Cross-Module Call Flows',
  15: 'Data Transformations',
  16: 'Configuration & Environment',
  17: 'Error Handling Patterns',
  18: 'Validation Rules',
  19: 'State Transitions',
  20: 'Async Processing Patterns',
  21: 'Testing & Verification',
  22: 'Transaction Boundaries',
  23: 'Event Flows',
  24: 'External Integrations',
  25: 'Scheduled Jobs & Workers',
  26: 'Risk Scorecard & Migration Complexity',
};

/**
 * Assembles all 26 section files into a single Stage1_Analysis.md.
 * This is the final Stage 5 step — no LLM involved.
 *
 * @param modernPath   Absolute path to the output directory (where Stage1_Analysis.md is written)
 * @param sessionId    Session ID (for logging only)
 * @param onLog        Optional log callback for progress reporting
 * @returns            List of any missing sections (section numbers that had no file)
 */
export async function assembleSections(
  modernPath: string,
  sessionId: string,
  onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void
): Promise<{ written: boolean; missingSections: number[] }> {
  const sectionsDir = path.join(modernPath, '_analysis', 'sections');
  const outputFile  = path.join(modernPath, 'Stage1_Analysis.md');

  // Ensure sections directory exists
  await fs.ensureDir(sectionsDir);

  // Document header
  const header = [
    '# Stage 1 — Legacy Codebase Analysis',
    '',
    '> Analyzed by @FileAnalyzer — Industry-Standard Multi-Phase Analysis',
    '> Generated in 5 stages: Discovery → File Analysis → Graph Resolution → Section Writing → Assembly',
    '',
    '---',
    '',
    '## Table of Contents',
    '',
    ...SECTION_NUMBERS.map(n => `${n}. [${SECTION_NAMES[n]}](#${n}-${SECTION_NAMES[n].toLowerCase().replace(/[^a-z0-9]+/g, '-')})`),
    '',
    '---',
    '',
  ].join('\n');

  const sectionContents: string[] = [];
  const missingSections: number[] = [];

  for (const n of SECTION_NUMBERS) {
    const sectionFile = path.join(sectionsDir, `section-${String(n).padStart(2, '0')}.md`);

    if (await fs.pathExists(sectionFile)) {
      const content = await fs.readFile(sectionFile, 'utf-8');
      sectionContents.push(content.trim());
      onLog?.(`  Section ${n}: ${SECTION_NAMES[n]}`, 'success');
    } else {
      // Section is missing — write a placeholder so the document is still complete
      const placeholder = [
        `## ${n}. ${SECTION_NAMES[n]}`,
        '',
        '> ⚠️ This section was not written during the analysis run.',
        '> Re-run the analyzer to generate this section.',
        '',
      ].join('\n');
      sectionContents.push(placeholder);
      missingSections.push(n);
      onLog?.(`  Section ${n} missing — placeholder inserted`, 'warning');
    }
  }

  // ── Completeness Status Table (TypeScript only — no LLM) ───────────────────
  // Shows ✅/❌ per section at the top of Stage1_Analysis.md.
  // Lets the user see at a glance which sections need re-running.
  const completenessCount = 26 - missingSections.length;
  const statusRows = SECTION_NUMBERS.map(n => {
    const done = !missingSections.includes(n);
    return `| ${String(n).padStart(2)} | ${SECTION_NAMES[n].padEnd(40)} | ${done ? '✅ Written' : '❌ Missing'} |`;
  });

  const statusBlock = [
    '## Analysis Completeness Report',
    '',
    `> **${completenessCount}/26 sections written** · Generated: ${new Date().toISOString()}`,
    missingSections.length > 0
      ? `> ⚠️ ${missingSections.length} section(s) incomplete — re-run the analyzer to complete them.`
      : '> ✅ All 26 sections written successfully.',
    '',
    '| #  | Section Name                             | Status    |',
    '|:---|:-----------------------------------------|:----------|',
    ...statusRows,
    '',
    '---',
    '',
  ].join('\n');

  // Write the complete document: header + completeness table + all sections
  const fullDocument = header + statusBlock + sectionContents.join('\n\n---\n\n') + '\n';
  await fs.writeFile(outputFile, fullDocument, 'utf-8');

  const totalSize = Buffer.byteLength(fullDocument, 'utf-8');
  const sizeKb    = Math.round(totalSize / 1024);

  onLog?.(
    `Stage1_Analysis.md assembled: ${completenessCount}/26 sections, ${sizeKb} KB`,
    'success'
  );

  if (missingSections.length > 0) {
    onLog?.(
      `Missing sections: ${missingSections.join(', ')} — re-run to complete them`,
      'warning'
    );
  }

  return {
    written: true,
    missingSections,
  };
}

/**
 * Checks which sections are already written to disk.
 * Used by the orchestrator to skip already-written sections on resume.
 *
 * @param modernPath  Absolute path to the output directory
 * @returns           Set of section numbers that exist on disk
 */
export async function getWrittenSections(modernPath: string): Promise<Set<number>> {
  const sectionsDir = path.join(modernPath, '_analysis', 'sections');
  const written     = new Set<number>();

  if (!(await fs.pathExists(sectionsDir))) return written;

  for (const n of SECTION_NUMBERS) {
    const sectionFile = path.join(sectionsDir, `section-${String(n).padStart(2, '0')}.md`);
    if (await fs.pathExists(sectionFile)) written.add(n);
  }

  return written;
}

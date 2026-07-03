

import fs from 'fs-extra';
import path from 'path';

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

export async function assembleSections(
  modernPath: string,
  sessionId: string,
  onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void
): Promise<{ written: boolean; missingSections: number[] }> {
  const sectionsDir = path.join(modernPath, '_analysis', 'sections');
  const outputFile  = path.join(modernPath, 'Stage1_Analysis.md');

  
  await fs.ensureDir(sectionsDir);

  
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

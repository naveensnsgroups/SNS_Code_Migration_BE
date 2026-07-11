// Section-writing mini-system for Stage 1's Section Writer phase — a
// self-contained unit (write attempt → validate → retry → TypeScript
// fallback → "not applicable" note) that was previously bolted onto
// planner-agent.ts alongside the actual phase-sequencing logic.
import fs   from 'fs-extra';
import path from 'path';
import { toolRegistry }        from '../../core/tool-invocation-registry.js';
import { ToolContext }         from '../../types/tool.js';
import { AgentExecutor }       from '../core/agentExecutor.js';
import { TaskContextManager }  from '../../session/taskContext.js';
import { lockWriteFileTool }   from '../core/tool-locking.js';
import { SECTION_WRITER_AGENT } from '../core/agent-definitions.js';
import { StreamingProvider }   from '../../types/language-model.js';
import { SectionConfig, buildSectionUserPrompt } from '../../prompts/section-writer-prompt.js';
import { LogFn, withPhaseTimeout } from '../core/agent-concurrency-utils.js';
import { isGraphEmpty } from './graph-resolver.js';

// Maps a section's source graph name to the DATA_GAP_* flag Pass C/D save when
// that graph exists but holds zero real entries (see graph-resolution-prompt.ts).
// entity/api/symbol/rule/db are covered — those are the five graphs Pass C checks.
const DATA_GAP_KEY_BY_GRAPH: Record<string, string> = {
  entity: 'DATA_GAP_ENTITY',
  api:    'DATA_GAP_API',
  symbol: 'DATA_GAP_SYMBOL',
  rule:   'DATA_GAP_RULE',
  db:     'DATA_GAP_DB',
};

async function validateSectionFile(
  filePath: string,
  minBytes: number,
  section:  SectionConfig
): Promise<{ valid: boolean; failureReason: string }> {
  if (!(await fs.pathExists(filePath))) {
    return { valid: false, failureReason: 'file was not created (agent did not call write_file)' };
  }
  const stat = await fs.stat(filePath);
  if (stat.size < minBytes) {
    return {
      valid: false,
      failureReason: `file is only ${stat.size} bytes (minimum ${minBytes} bytes for section ${section.n}: ${section.name})`
    };
  }
  return { valid: true, failureReason: '' };
}

async function writeEmptySection(
  filePath:  string,
  section:   SectionConfig,
  reason:    string,
  sessionId?: string
): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));

  // Check whether graph resolution flagged this section's graph as a confirmed
  // DATA GAP (graph exists but is empty — data was lost, not genuinely absent).
  // Without this check, the TypeScript fallback path silently overwrote that
  // signal with a generic "not applicable" note and leaked internal details
  // (byte-count/retry reasons) instead of telling the reader the truth.
  let isConfirmedGap = false;
  if (sessionId && section.graph && section.graph in DATA_GAP_KEY_BY_GRAPH) {
    try {
      const ctx = await TaskContextManager.getContext(sessionId);
      isConfirmedGap = ctx[DATA_GAP_KEY_BY_GRAPH[section.graph]] === true;
    } catch { /* non-blocking — fall through to the generic message */ }
  }

  const content = isConfirmedGap
    ? [
        `## ${section.n}. ${section.name}`,
        '',
        `> DATA GAP WARNING: the \`${section.graph}\` graph is empty, but graph resolution ` +
          `recorded this codebase as having real entries for it. This indicates a Phase 2 ` +
          `(File Analysis) coverage gap — this section is likely INCOMPLETE, not genuinely empty.`,
        `> Re-run the analysis phase to recover this data.`,
        '',
        `This section covers ${section.name.toLowerCase()}. It could not be written from ` +
          `available data due to the gap above.`,
        '',
      ].join('\n')
    : [
        `## ${section.n}. ${section.name}`,
        '',
        `> ℹ️ Not applicable for this codebase.`,
        `> Reason: ${reason}`,
        '',
        `This section covers ${section.name.toLowerCase()}, which was not detected in this project.`,
        section.graph
          ? `The \`${section.graph}\` knowledge graph contained no entries.`
          : 'No relevant data was found in the task context.',
        '',
      ].join('\n');

  await fs.writeFile(filePath, content, 'utf-8');
}

async function writeFallbackSection(
  filePath:   string,
  section:    SectionConfig,
  modernPath: string
): Promise<boolean> {
  if (!section.graph) return false;

  const graphFile = path.join(modernPath, '_analysis', `${section.graph}-graph.json`);
  if (!(await fs.pathExists(graphFile))) return false;

  try {
    const graphRaw  = await fs.readFile(graphFile, 'utf-8');
    const graphData = JSON.parse(graphRaw);

    await fs.ensureDir(path.dirname(filePath));

    const lines: string[] = [
      `## ${section.n}. ${section.name}`,
      '',
      `> LLM section writer failed after 2 attempts. Raw graph data follows.`,
      `> This data was written directly by the TypeScript assembler from \`${section.graph}-graph.json\`.`,
      '',
    ];

    for (const [key, value] of Object.entries(graphData)) {
      // "_sources" is internal dedup bookkeeping (which files wrote to this
      // graph) — not domain content. Rendering it produced a fake "### _sources"
      // entry that looked like a real function/table in the report.
      if (key === '_sources') continue;
      if (value === null || value === undefined) continue;
      lines.push(`### ${key}`);
      lines.push('');
      if (Array.isArray(value) && value.length > 0) {
        lines.push('```json');
        lines.push(JSON.stringify(value.slice(0, 50), null, 2));
        if (value.length > 50) lines.push(`// ... and ${value.length - 50} more entries`);
        lines.push('```');
      } else if (typeof value === 'object') {
        lines.push('```json');
        lines.push(JSON.stringify(value, null, 2).slice(0, 3000));
        lines.push('```');
      } else {
        lines.push(String(value));
      }
      lines.push('');
    }

    await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export async function writeSingleSection(
  section:          SectionConfig,
  provider:         StreamingProvider,
  systemPrompt:     string,
  modernPath:       string,
  tools:            ReturnType<typeof toolRegistry.getFunctions>,
  context:          ToolContext,
  resolvedModel:    string,
  alreadyWritten:   Set<number>,
  naSkippedSections: Set<number>,
  sessionId:        string,
  language:         string | undefined,
  framework:        string | undefined,
  sectionTimeoutMs: number,
  onLog?:           LogFn,
  onSectionDone?:   () => void
): Promise<void> {
  const nn          = String(section.n).padStart(2, '0');
  const sectionRelativePath = path.join('_analysis', 'sections', `section-${nn}.md`);
  const sectionFile = path.join(modernPath, sectionRelativePath);
  const graphsDir   = path.join(modernPath, '_analysis');

  if (alreadyWritten.has(section.n)) {
    onLog?.(`[PlannerAgent] Section ${section.n} already on disk — skipping.`, 'info');
    return;
  }

  if (naSkippedSections.has(section.n)) {
    onLog?.(`[PlannerAgent] Section ${section.n} previously marked N/A — skipping (no graph data for this codebase).`, 'info');
    onSectionDone?.();
    return;
  }

  if (section.graph) {
    const graphFile = path.join(graphsDir, `${section.graph}-graph.json`);
    const graphExists = await fs.pathExists(graphFile);

    if (!graphExists) {
      if (section.emptyGraphIsValid) {
        await writeEmptySection(sectionFile, section, 'graph file not found — not applicable for this codebase', sessionId);
        await TaskContextManager.updateContext(sessionId, { [`SECTION_${section.n}_STATUS`]: 'skipped-empty-graph' });
        onLog?.(`[PlannerAgent] Section ${section.n}: ${section.graph}-graph not found — writing "not applicable" note.`, 'info');
        onSectionDone?.();
        return;
      }
      onLog?.(`[PlannerAgent] Section ${section.n}: ${section.graph}-graph missing (resolver may have skipped it) — attempting LLM write.`, 'warning');
    } else {
      try {
        const graphRaw  = await fs.readFile(graphFile, 'utf-8');
        const graphData = JSON.parse(graphRaw);

        const isEmpty = isGraphEmpty(graphData);
        if (isEmpty && section.emptyGraphIsValid) {
          await writeEmptySection(sectionFile, section, `${section.graph} graph contains no entries — not applicable for this codebase`, sessionId);
          await TaskContextManager.updateContext(sessionId, { [`SECTION_${section.n}_STATUS`]: 'skipped-empty-graph' });
          onLog?.(`[PlannerAgent] Section ${section.n}: ${section.graph}-graph is empty — writing "not applicable" note (emptyGraphIsValid=true).`, 'info');
          onSectionDone?.();
          return;
        }
      } catch {
        onLog?.(`[PlannerAgent] Section ${section.n}: could not parse ${section.graph}-graph.json — proceeding with LLM.`, 'warning');
      }
    }
  }

  const minBytes = section.minContentBytes;

  onLog?.(`[PlannerAgent] Writing section ${section.n}: ${section.name}...`, 'info');
  const userPrompt = buildSectionUserPrompt(section, modernPath, language, framework);

  // Never trust the model's own write_file path argument for section writing —
  // the correct destination is already known deterministically in code. Without
  // this, a model that writes good content to the wrong path gets scored as
  // "file was not created", triggers an unnecessary retry, and the good content
  // is stranded at an orphaned path while a worse fallback lands at the real one.
  const lockedTools = lockWriteFileTool(tools, sectionRelativePath);

  await withPhaseTimeout(
    AgentExecutor.execute(
      provider, systemPrompt, userPrompt, lockedTools, context,
      resolvedModel, `section-${section.n}`,
      undefined, SECTION_WRITER_AGENT.recoveryHint
    ),
    sectionTimeoutMs,
    `section-${section.n}-first-attempt`,
    onLog
  );

  const { valid, failureReason } = await validateSectionFile(sectionFile, minBytes, section);
  if (valid) {
    const stat = await fs.stat(sectionFile);
    onLog?.(`[PlannerAgent] Section ${section.n} written: ${section.name} (${stat.size} bytes)`, 'success');
    onSectionDone?.();
    return;
  }

  onLog?.(`[PlannerAgent] Section ${section.n} needs retry — ${failureReason}`, 'warning');

  const retryPrompt = userPrompt +
    `\n\nPREVIOUS ATTEMPT FAILED: ${failureReason}\n` +
    `The section file is either missing or has fewer than ${minBytes} bytes of content.\n` +
    `Fix: Read the data source again (${section.graph ? `read-knowledge-graph("${section.graph}")` : 'get_task_context'}) ` +
    `and write ALL entries found. Include every item — do not truncate.\n` +
    `Then call write_file to save the complete section.`;

  await withPhaseTimeout(
    AgentExecutor.execute(
      provider, systemPrompt, retryPrompt, lockedTools, context,
      resolvedModel, `section-${section.n}-retry`,
      undefined, SECTION_WRITER_AGENT.recoveryHint
    ),
    sectionTimeoutMs,
    `section-${section.n}-retry`,
    onLog
  );

  const { valid: retryValid, failureReason: retryReason } = await validateSectionFile(sectionFile, minBytes, section);

  if (retryValid) {
    const retryStat = await fs.stat(sectionFile);
    onLog?.(`[PlannerAgent] Section ${section.n} written on retry (${retryStat.size} bytes).`, 'success');
    onSectionDone?.();
    return;
  }

  onLog?.(`[PlannerAgent] Section ${section.n} LLM failed twice (${retryReason}). Writing TypeScript fallback.`, 'error');

  const fallbackWritten = await writeFallbackSection(sectionFile, section, modernPath);
  if (fallbackWritten) {
    onLog?.(`[PlannerAgent] Section ${section.n} fallback written from raw graph data.`, 'warning');
  } else {
    await writeEmptySection(sectionFile, section, `LLM failed after 2 attempts — ${retryReason}`, sessionId);
    onLog?.(`[PlannerAgent] Section ${section.n}: could not write from raw data. Informational note written.`, 'warning');
  }

  onSectionDone?.();
}

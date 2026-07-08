

import path from 'path';
import fs   from 'fs-extra';

import { ToolRequest, ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';
import { APPEND_TO_KNOWLEDGE_GRAPH_FUNCTION_ID } from '../../common/workspace-functions.js';
import { mergeGraphData, getValidGraphNames }    from './knowledge-graph-utils.js';
import { buildGraphShapeHintDoc }                from './graph-schemas.js';
import { writeJsonAtomic, readJsonWithRetry, enqueueKeyedWrite } from '../../session/fileUtils.js';

export const appendToKnowledgeGraphTool: ToolRequest = {
  id:           APPEND_TO_KNOWLEDGE_GRAPH_FUNCTION_ID,     
  name:         'append-to-knowledge-graph',
  providerName: 'migration-knowledge',
  description:
    'Merges new analysis data into a named knowledge graph file stored in the output workspace ' +
    '(_analysis/<graphName>-graph.json). Call this after EVERY file analysis to incrementally ' +
    'build cross-file knowledge graphs. Instead of loading 50+ raw per-file analysis keys at ' +
    'report time, the agent reads the pre-merged graphs. ' +
    'Valid graphName values: entity, symbol, rule, api, db, event, config, state, middleware, ' +
    'security, transform, error, async, test, integration, job, call-flow, architecture, imports. ' +
    'Data is merged intelligently: entity/symbol/api/db/event/imports graphs merge by key name; ' +
    'rule/transform/test graphs append arrays; security/architecture/middleware/error graphs deep-merge. ' +
    'CRITICAL RULES: ' +
    '(1) sourceFile is REQUIRED — always pass the exact file path you just read. ' +
    '(2) Each sourceFile+graphName combination can only be written ONCE — duplicate calls are rejected automatically. ' +
    '(3) data:{} (empty object) is REJECTED — you must extract real content from the file first. ' +
    '(4) After finishing ALL graphs for a file, call edit-task-context to mark it DONE — do NOT call append-to-knowledge-graph again for that file. ' +
    '(5) If a file genuinely has no data for a graph type, simply skip that graph — do not call this tool with empty data.',
  parameters: {
    type: 'object',
    properties: {
      graphName: {
        type: 'string',
        description:
          'Name of the knowledge graph to update. Must be one of: ' +
          'entity, symbol, rule, api, db, event, config, state, middleware, ' +
          'security, transform, error, async, test, integration, job, call-flow, architecture, imports.'
      },
      data: {
        type: 'object',
        description:
          'Data to merge into the graph. Shape must match the graph schema (canonical shapes, ' +
          'kept in sync with the analysis prompt\'s <graph_shapes>): ' +
          buildGraphShapeHintDoc()
      },
      sourceFile: {
        type: 'string',
        description: 'REQUIRED. The exact file path that was just read and produced this data (e.g. "src/models/user.ts"). ' +
          'Used for deduplication — each sourceFile+graphName pair can only be written once per session. ' +
          'Always pass this so duplicate calls are automatically detected and rejected.'
      }
    },
    required: ['graphName', 'data', 'sourceFile']
  },

  handler: async (arg_string: string, ctx?: ToolContext) => {
    let args: { graphName: string; data: Record<string, any>; sourceFile?: string };
    try {
      args = typeof arg_string === 'string' ? JSON.parse(arg_string) : arg_string;
    } catch {
      return makeToolErrorResult('append-to-knowledge-graph: invalid JSON arguments.');
    }

    const validNames = getValidGraphNames();
    if (!validNames.includes(args.graphName)) {
      return makeToolErrorResult(
        `Unknown graphName "${args.graphName}". Valid names: ${validNames.join(', ')}.`
      );
    }

    
    
    
    if (!args.sourceFile || args.sourceFile.trim() === '') {
      return makeToolErrorResult(
        `MISSING sourceFile for graph "${args.graphName}". ` +
        `You must always pass sourceFile with the exact path of the file you just read. ` +
        `Example: sourceFile: "src/models/user.ts". ` +
        `This field is required to prevent duplicate writes.`
      );
    }

    
    
    
    
    
    const topLevelKeys = Object.keys(args.data ?? {});
    if (topLevelKeys.length === 0) {
      return makeToolErrorResult(
        `EMPTY DATA REJECTED for graph "${args.graphName}" (sourceFile: "${args.sourceFile}"). ` +
        `You called append-to-knowledge-graph with data:{} — this saves nothing. ` +
        `You have TWO options: ` +
        `(A) If this file HAS data for "${args.graphName}": READ the file content first, EXTRACT the data, BUILD the correct schema, then call this tool again with real data. ` +
        `(B) If this file genuinely has NO data for "${args.graphName}": DO NOT call this tool at all. Simply SKIP this graph and move to the next graph type. ` +
        `When ALL graphs for this file are done (or skipped): update read_status="DONE" for this file ` +
        `inside the FILE_INDEX array and re-save the full array via edit_task_context({ "file-index": [updatedArray] }). ` +
        `See the graph_shapes section in your system prompt for the required schema for "${args.graphName}".`
      );
    }

    
    
    
    
    if (!ctx?.modernPath) {
      return makeToolErrorResult(
        'append-to-knowledge-graph: modernPath not set in tool context. ' +
        'This is an internal configuration error — the session may not have initialized correctly. ' +
        'Do not retry this tool call. Report the error and stop.'
      );
    }

    const analysisDir = path.join(ctx.modernPath, '_analysis');
    await fs.ensureDir(analysisDir);
    const graphPath = path.join(analysisDir, `${args.graphName}-graph.json`);

    // Defensive sanitization: models occasionally wrap a composite-string key
    // (a file path, or "METHOD /path") in literal quote characters — e.g. the
    // key ends up as the 22-char string `"backend/server.js"` instead of the
    // 18-char `backend/server.js`. No real path or route ever legitimately
    // starts AND ends with a literal quote, so stripping one matched pair is
    // always safe and never destroys a genuine key. This is enforced here
    // (not just requested in the prompt) because every downstream consumer —
    // dependency resolution, call-flow tracing, section writers, Stage 2 —
    // matches graph keys by exact string equality, and a single corrupted key
    // silently breaks every one of them.
    const stripWrappingQuotes = (key: string): string =>
      key.length > 1 && key.startsWith('"') && key.endsWith('"')
        ? key.slice(1, -1)
        : key;

    if (args.data && typeof args.data === 'object') {
      const cleaned: Record<string, any> = {};
      for (const [key, value] of Object.entries(args.data)) {
        cleaned[stripWrappingQuotes(key)] = value;
      }
      args.data = cleaned;
    }

    // The entire read→dedup-check→merge→write cycle is serialized per graph file.
    // Section writers and analysis passes run concurrently; without this queue two
    // callers read the same snapshot and the second write erases the first (data
    // AND its _sources dedup entry) while both still report success.
    return enqueueKeyedWrite(`graph:${graphPath}`, async () => {
      let existing: Record<string, any> = {};
      try {
        if (await fs.pathExists(graphPath)) {
          existing = await readJsonWithRetry<Record<string, any>>(graphPath);
        }
      } catch {
        existing = {};
      }


      const sources: string[] = Array.isArray(existing._sources) ? existing._sources : [];

      if (args.sourceFile && sources.includes(args.sourceFile)) {
        const skipMsg =
          `DUPLICATE WRITE BLOCKED: "${args.sourceFile}" has already contributed to the "${args.graphName}" graph. ` +
          `This call was rejected — no data was written. ` +
          `ACTION REQUIRED: Do NOT call append-to-knowledge-graph again for this file+graph combination. ` +
          `Move on to the NEXT graph type for this file, or if all graphs are done, ` +
          `call edit-task-context to mark this file DONE (read_status="DONE") immediately.`;
        ctx?.onLog?.(`[KnowledgeGraph] ${skipMsg}`, 'info');
        return makeToolErrorResult(skipMsg);
      }


      const merged = mergeGraphData(args.graphName, existing, args.data);


      if (args.sourceFile) {
        merged._sources = [...sources, args.sourceFile];
      }


      await writeJsonAtomic(graphPath, merged);


      const entryCount = Object.keys(merged).filter(k => k !== '_sources').length;
      const message = `Graph "${args.graphName}" updated: ${entryCount} top-level entries.`
        + (args.sourceFile ? ` (source: ${args.sourceFile})` : '');

      ctx?.onLog?.(`[KnowledgeGraph] ${message}`, 'info');

      return makeToolTextResult(JSON.stringify({
        success:   true,
        graphName: args.graphName,
        graphPath: `_analysis/${args.graphName}-graph.json`,
        entryCount,
        message
      }));
    });
  }
};

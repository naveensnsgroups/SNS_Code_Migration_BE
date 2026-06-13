// =============================================================================
//  tools/knowledge/append-to-knowledge-graph.tool.ts
//
//  Incrementally merges analysis data into a named knowledge graph file.
//  Called by the File Analysis Agent after EVERY file read during Phase 1.
//
//  SNS IDE standard: tool ID mirrors workspace-functions.ts constant exactly.
// =============================================================================

import path from 'path';
import fs   from 'fs-extra';

import { ToolRequest, ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';
import { APPEND_TO_KNOWLEDGE_GRAPH_FUNCTION_ID } from '../../common/workspace-functions.js';
import { mergeGraphData, getValidGraphNames }    from './knowledge-graph-utils.js';
import { writeJsonAtomic, readJsonWithRetry }    from '../../session/fileUtils.js';

export const appendToKnowledgeGraphTool: ToolRequest = {
  id:           APPEND_TO_KNOWLEDGE_GRAPH_FUNCTION_ID,     // 'append-to-knowledge-graph'
  name:         'append-to-knowledge-graph',
  providerName: 'migration-knowledge',
  description:
    'Merges new analysis data into a named knowledge graph file stored in the output workspace ' +
    '(_analysis/<graphName>-graph.json). Call this after EVERY file analysis to incrementally ' +
    'build cross-file knowledge graphs. Instead of loading 50+ raw per-file analysis keys at ' +
    'report time, the agent reads the pre-merged graphs. ' +
    'Valid graphName values: entity, symbol, rule, api, db, event, config, state, middleware, ' +
    'security, transform, error, async, test, integration, job, call-flow, architecture. ' +
    'Data is merged intelligently: entity/symbol/api/db/event graphs merge by key name; ' +
    'rule/transform/test graphs append arrays; security/architecture/middleware/error graphs deep-merge. ' +
    'MANDATORY after each file read — do NOT skip this step. ' +
    'IMPORTANT: data:{} (empty object) is REJECTED — you must extract real content from the file first. ' +
    'Only call this tool when you have actual data to add (functions, DB ops, routes, config keys, etc.).',
  parameters: {
    type: 'object',
    properties: {
      graphName: {
        type: 'string',
        description:
          'Name of the knowledge graph to update. Must be one of: ' +
          'entity, symbol, rule, api, db, event, config, state, middleware, ' +
          'security, transform, error, async, test, integration, job, call-flow, architecture.'
      },
      data: {
        type: 'object',
        description:
          'Data to merge into the graph. Shape must match the graph schema. ' +
          'entity-graph: { "EntityName": { table, files:[...], fields:[...], relations:[...] } } ' +
          'symbol-graph: { "funcName": { file, signature, isAsync, calledBy:[...], calls:[...] } } ' +
          'rule-graph: { "domain": [{ rule, enforcement, violation, relatedFiles:[...] }] } ' +
          'api-graph: { "METHOD /path": { handler, auth, request:{}, responses:{}, middlewareChain:[...] } } ' +
          'db-graph: { "tableName": { operations:[{ type, fields, condition, function, calledFrom:[...] }] } } ' +
          'event-graph: { "event.name": { emittedIn, payload, listeners:[{ file, handler, does }] } } ' +
          'config-graph: { "CONFIG_KEY": { type, required, default, purpose, usedIn:[...] } } ' +
          'state-graph: { "EntityName": { field, modelFile, states:[...], transitions:[...] } } ' +
          'middleware-graph: { globalPipeline:[{ order, name, file, purpose }], routeSpecific:{} } ' +
          'security-graph: { authMechanism, tokenStrategy:{}, roles:{}, publicRoutes:[...] } ' +
          'transform-graph: { "Name": { inputShape:{}, inputFile, outputShape:{}, outputFile } } ' +
          'error-graph: { customErrors:{ "ErrorName": { extends, status, definedIn, thrownIn:[...] } } } ' +
          'async-graph: { "funcName": { pattern, awaits:[...], parallelOps:[...] } } ' +
          'test-graph: { framework, testFiles:{ "path": { covers, cases:[...], mocks:[...] } } } ' +
          'integration-graph: { "Provider": { purpose, auth, calledFrom, operations:[...] } } ' +
          'job-graph: { "Job Name": { schedule, scheduledIn, implementation, calls, type } } ' +
          'call-flow-graph: { "Use Case": { steps:[...] } } ' +
          'architecture-graph: { type, layers:[...], patterns:[...], modules:[...], entryPoint }'
      },
      sourceFile: {
        type: 'string',
        description: 'The file path that produced this data. Used for audit tracing. Optional but recommended.'
      }
    },
    required: ['graphName', 'data']
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

    // ── Reject empty data ──────────────────────────────────────────────────────
    // The LLM sometimes calls this tool with data:{} to "check off" the step
    // without doing the actual extraction work. This causes all graphs to stay
    // at 0 entries and produces empty sections in the Stage 1 report.
    // Hard-reject here so the LLM MUST retry with real extracted content.
    const topLevelKeys = Object.keys(args.data ?? {});
    if (topLevelKeys.length === 0) {
      return makeToolErrorResult(
        `EMPTY DATA REJECTED for graph "${args.graphName}". ` +
        `You called append-to-knowledge-graph with data:{} — this saves nothing and is not allowed. ` +
        `You must first READ the file content, EXTRACT the relevant data, and BUILD the correct schema. ` +
        `See the <graph_shapes> section in your system prompt for the required structure for "${args.graphName}". ` +
        `If this file genuinely has NO data for the "${args.graphName}" graph, simply DO NOT call this tool for that graph. ` +
        `Only call this tool when you have real data to contribute.`
      );
    }

    const analysisDir = path.join(ctx!.modernPath, '_analysis');
    await fs.ensureDir(analysisDir);
    const graphPath = path.join(analysisDir, `${args.graphName}-graph.json`);

    // Load existing graph (or start with empty object)
    let existing: Record<string, any> = {};
    try {
      if (await fs.pathExists(graphPath)) {
        existing = await readJsonWithRetry<Record<string, any>>(graphPath);
      }
    } catch {
      existing = {}; // If file is corrupt, start fresh
    }

    // Merge incoming data using the correct strategy for this graph type
    const merged = mergeGraphData(args.graphName, existing, args.data);

    // Write merged result back
    await writeJsonAtomic(graphPath, merged);

    const entryCount = Object.keys(merged).length;
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
  }
};

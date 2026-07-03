

import path from 'path';
import fs   from 'fs-extra';

import { ToolRequest, ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';
import { READ_KNOWLEDGE_GRAPH_FUNCTION_ID } from '../../common/workspace-functions.js';
import { getValidGraphNames }              from './knowledge-graph-utils.js';

export const readKnowledgeGraphTool: ToolRequest = {
  id:           READ_KNOWLEDGE_GRAPH_FUNCTION_ID,     
  name:         'read-knowledge-graph',
  providerName: 'migration-knowledge',
  description:
    'Reads the current state of a named knowledge graph file from the output workspace. ' +
    'Use this at REPORT WRITING TIME (Phase 1_5) instead of loading raw per-file analysis ' +
    'keys from task context. Each section has a designated source graph — read that graph ' +
    'and write the section directly from the pre-merged, cross-referenced data. ' +
    'Section → Graph mapping: ' +
    '5(Domain Models)→entity | 7(Functions)→symbol | 8(Behaviors)→symbol | 9(Business Rules)→rule | ' +
    '10(API Contracts)→api | 11(Security)→security | 12(Middleware)→middleware | 13(DB Ops)→db | ' +
    '14(Call Flows)→call-flow | 15(Transforms)→transform | 16(Config)→config | 17(Errors)→error | ' +
    '18(Validation)→rule | 19(State)→state | 20(Async)→async | 21(Tests)→test | ' +
    '22(Transactions)→db | 23(Events)→event | 24(Integrations)→integration | 25(Jobs)→job | ' +
    '2(Architecture)→architecture | 26(Risk/Migration)→imports (for migration ordering).',
  parameters: {
    type: 'object',
    properties: {
      graphName: {
        type: 'string',
        description:
          'Name of the graph to read. One of: ' +
          'entity, symbol, rule, api, db, event, config, state, middleware, ' +
          'security, transform, error, async, test, integration, job, call-flow, architecture, imports.'
      },
      filter: {
        type: 'object',
        description:
          'Optional. Filter entries before returning. ' +
          'Use { pathPrefix: "src/users/" } to return only entries from files in that directory. ' +
          'Use { keys: ["createUser","updateUser"] } to return only specific top-level keys. ' +
          'If omitted: returns all entries.'
      },
      limit: {
        type: 'number',
        description:
          'Optional. Maximum number of top-level entries to return. ' +
          'If graph has more entries, returns the first N plus a truncated:true flag. ' +
          'Use limit=50 for section writing to avoid context overflow.'
      }
    },
    required: ['graphName']
  },

  handler: async (arg_string: string, ctx?: ToolContext) => {
    let args: { graphName: string; filter?: { pathPrefix?: string; keys?: string[] }; limit?: number };
    try {
      args = typeof arg_string === 'string' ? JSON.parse(arg_string) : arg_string;
    } catch {
      return makeToolErrorResult('read-knowledge-graph: invalid JSON arguments.');
    }

    const validNames = getValidGraphNames();
    if (!validNames.includes(args.graphName)) {
      return makeToolErrorResult(
        `Unknown graphName "${args.graphName}". Valid names: ${validNames.join(', ')}.`
      );
    }

    const graphPath = path.join(ctx!.modernPath, '_analysis', `${args.graphName}-graph.json`);

    if (!(await fs.pathExists(graphPath))) {
      return makeToolTextResult(JSON.stringify({
        exists:     false,
        graphName:  args.graphName,
        data:       {},
        entryCount: 0,
        truncated:  false,
        message:    `Graph not yet built: _analysis/${args.graphName}-graph.json. ` +
          `Run Phase 1 analysis first so append-to-knowledge-graph can populate this graph.`
      }));
    }

    let data: Record<string, any> = {};
    try {
      data = await fs.readJson(graphPath);
    } catch (err: any) {
      return makeToolErrorResult(
        `Failed to read graph "${args.graphName}": ${err.message}`
      );
    }

    
    const { _sources, ...domainData } = data;

    
    let filteredData: Record<string, any> = domainData;
    const f = args.filter;
    if (f) {
      if (f.pathPrefix) {
        filteredData = Object.fromEntries(
          Object.entries(domainData).filter(([k]) => k.startsWith(f.pathPrefix!))
        );
      } else if (f.keys && Array.isArray(f.keys)) {
        filteredData = Object.fromEntries(
          Object.entries(domainData).filter(([k]) => f.keys!.includes(k))
        );
      }
    }

    
    let truncated = false;
    const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined;
    if (limit && Object.keys(filteredData).length > limit) {
      const keys = Object.keys(filteredData).slice(0, limit);
      filteredData = Object.fromEntries(keys.map(k => [k, filteredData[k]]));
      truncated = true;
    }

    
    let qualityStats: Record<string, number> | undefined;
    if (args.graphName === 'symbol') {
      const entries = Object.values(domainData) as any[];
      const withPseudocode  = entries.filter(e => e?.pseudocode && String(e.pseudocode).trim().length > 10).length;
      const withSideEffects = entries.filter(e => Array.isArray(e?.sideEffects) && e.sideEffects.length > 0).length;
      const shallowPseudo   = entries.filter(e => {
        const p = String(e?.pseudocode ?? '');
        return p.length > 0 && p.split('\n').filter((l: string) => /^\d+\./.test(l.trim())).length < 3;
      }).length;
      qualityStats = {
        totalSymbols:     entries.length,
        withPseudocode,
        withSideEffects,
        shallowPseudocode: shallowPseudo,
      };
    }

    const entryCount     = Object.keys(filteredData).length;
    const totalEntries   = Object.keys(domainData).length;
    const graphSizeBytes = JSON.stringify(filteredData).length;

    ctx?.onLog?.(
      `[KnowledgeGraph] Read "${args.graphName}-graph": ${entryCount} entries returned` +
        (truncated ? ` (${totalEntries} total, truncated)` : '') +
        `, ${Math.round(graphSizeBytes / 1024)}KB`,
      'info'
    );

    return makeToolTextResult(JSON.stringify({
      exists:         true,
      graphName:      args.graphName,
      graphPath:      `_analysis/${args.graphName}-graph.json`,
      data:           filteredData,
      entryCount,
      totalEntries,
      truncated,
      graphSizeBytes,
      qualityStats,
      message: `Loaded ${args.graphName}-graph: ${entryCount} entries returned` +
        (truncated ? ` (truncated — ${totalEntries} total; use filter/limit to page through remaining)` : '') +
        `.`
    }));
  }
};

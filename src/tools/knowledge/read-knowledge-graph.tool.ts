// =============================================================================
//  tools/knowledge/read-knowledge-graph.tool.ts
//
//  Reads a fully-merged knowledge graph at report-writing time (Phase 1_5).
//  Called by the Graph Resolver Agent and Section Writer Agent.
//
//  SNS IDE standard: tool ID mirrors workspace-functions.ts constant exactly.
// =============================================================================

import path from 'path';
import fs   from 'fs-extra';

import { ToolRequest, ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';
import { READ_KNOWLEDGE_GRAPH_FUNCTION_ID } from '../../common/workspace-functions.js';
import { getValidGraphNames }              from './knowledge-graph-utils.js';

export const readKnowledgeGraphTool: ToolRequest = {
  id:           READ_KNOWLEDGE_GRAPH_FUNCTION_ID,     // 'read-knowledge-graph'
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
    '2(Architecture)→architecture.',
  parameters: {
    type: 'object',
    properties: {
      graphName: {
        type: 'string',
        description:
          'Name of the graph to read. One of: ' +
          'entity, symbol, rule, api, db, event, config, state, middleware, ' +
          'security, transform, error, async, test, integration, job, call-flow, architecture.'
      }
    },
    required: ['graphName']
  },

  handler: async (arg_string: string, ctx?: ToolContext) => {
    let args: { graphName: string };
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

    const entryCount     = Object.keys(data).length;
    const graphSizeBytes = JSON.stringify(data).length;

    ctx?.onLog?.(
      `[KnowledgeGraph] Read "${args.graphName}-graph": ${entryCount} entries, ${Math.round(graphSizeBytes / 1024)}KB`,
      'info'
    );

    return makeToolTextResult(JSON.stringify({
      exists:         true,
      graphName:      args.graphName,
      graphPath:      `_analysis/${args.graphName}-graph.json`,
      data,
      entryCount,
      graphSizeBytes,
      message: `Loaded ${args.graphName}-graph: ${entryCount} top-level entries.`
    }));
  }
};

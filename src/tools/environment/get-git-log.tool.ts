

import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { ShellExecutor } from '../shellExecutor.js';
import { GET_GIT_LOG_FUNCTION_ID } from '../../common/workspace-functions.js';
import { parseToolArgs } from '../tool-args.js';

export const getGitLogTool: ToolRequest = {
  id: GET_GIT_LOG_FUNCTION_ID,
  name: 'getGitLog',
  providerName: 'migration-environment',
  description:
    'Retrieves git commit history from the legacy workspace. ' +
    'Returns recent commits, high-churn files (most commits), and dead code candidates (no commits in past year). ' +
    'Use during Phase 1 environment probe to identify migration risk areas.',
  parameters: {
    type: 'object',
    properties: {
      maxCommits: { type: 'number', description: 'Maximum commits to retrieve (default: 200).' }
    },
    required: []
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const parsed = parseToolArgs<{ maxCommits?: number }>(arg_string, 'getGitLog');
    if (!parsed.ok) return parsed.error;
    const max = parsed.value.maxCommits ?? 200;
    try {
      const res = await ShellExecutor.execute(
        ctx!.sessionId,
        `git log --name-only --format="COMMIT:%H|%ai|%s" -n ${max} -- .`,
        { cwd: ctx!.legacyPath, timeoutMs: 15000 }
      );
      if (res.code !== 0) {
        return makeToolErrorResult(`getGitLog: git log failed (not a git repo or git not installed). ${res.stderr ?? ''}`.trim());
      }

      const lines = res.stdout.split('\n');
      const commits: { hash: string; date: string; message: string; files: string[] }[] = [];
      const fileCounts: Record<string, number> = {};
      let currentCommit: typeof commits[0] | null = null;
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const recentFiles = new Set<string>();

      for (const line of lines) {
        if (line.startsWith('COMMIT:')) {
          if (currentCommit) commits.push(currentCommit);
          const parts = line.split('|');
          currentCommit = { hash: parts[0]?.replace('COMMIT:', ''), date: parts[1], message: parts.slice(2).join('|'), files: [] };
        } else if (line.trim() && currentCommit && !line.startsWith('COMMIT:')) {
          currentCommit.files.push(line.trim());
          fileCounts[line.trim()] = (fileCounts[line.trim()] || 0) + 1;
          if (currentCommit.date && new Date(currentCommit.date) > oneYearAgo) recentFiles.add(line.trim());
        }
      }
      if (currentCommit) commits.push(currentCommit);

      const highChurnFiles = Object.entries(fileCounts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([file, count]) => ({ file, commits: count }));
      const deadCodeCandidates = Object.keys(fileCounts).filter(f => !recentFiles.has(f)).slice(0, 20);

      return makeToolTextResult(JSON.stringify({ totalCommits: commits.length, commits: commits.slice(0, 20), highChurnFiles, deadCodeCandidates, note: `Full history: ${commits.length} commits analyzed.` }));
    } catch (err: unknown) {
      return makeToolErrorResult(`getGitLog failed: ${(err as Error).message}`);
    }
  }
};

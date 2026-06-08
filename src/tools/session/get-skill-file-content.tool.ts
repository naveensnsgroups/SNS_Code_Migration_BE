// =============================================================================
//  tools/session/get-skill-file-content.tool.ts
//  Mirrors: GetSkillFileContent (snside skill-file-functions.ts)
// =============================================================================

import fs from 'fs-extra';
import path from 'path';
import { ToolRequest } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';
import { GET_SKILL_FILE_CONTENT_FUNCTION_ID } from '../../common/workspace-functions.js';
// GET_SKILL_FILE_CONTENT_FUNCTION_ID = 'getSkillFileContent' — SNS IDE exact value

export const getSkillFileContentTool: ToolRequest = {
  id: GET_SKILL_FILE_CONTENT_FUNCTION_ID,
  name: 'getSkillFileContent',
  providerName: 'migration-session',
  description: 'Reads a custom skill/rule template file from the skills directory. Skills are Markdown files with custom migration rules.',
  parameters: {
    type: 'object',
    properties: {
      skillPath: { type: 'string', description: 'Name or relative path of the skill file (e.g. "custom-rules.md").' }
    },
    required: ['skillPath']
  },
  handler: async (arg_string: string, _ctx?) => {
    const args: { skillPath: string } = JSON.parse(arg_string || '{}');
    try {
      const skillsDir = path.join(process.cwd(), 'skills');
      const skillPath = path.resolve(skillsDir, args.skillPath);
      if (!skillPath.startsWith(skillsDir)) throw new Error('Access denied.');
      if (!(await fs.pathExists(skillPath))) {
        return makeToolTextResult(JSON.stringify({ content: '', note: `Skill file "${args.skillPath}" not found. Using default behavior.` }));
      }
      const content = await fs.readFile(skillPath, 'utf-8');
      return makeToolTextResult(JSON.stringify({ content, skillPath: args.skillPath }));
    } catch (err: unknown) {
      return makeToolTextResult(JSON.stringify({ content: '', error: (err as Error).message }));
    }
  }
};

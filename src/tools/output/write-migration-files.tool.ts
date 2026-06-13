// =============================================================================
//  tools/output/write-migration-files.tool.ts
//  Mirrors: MultiFileWriter (snside migration-multi-writer-tool.ts)
// =============================================================================

import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { writeSessionFile } from '../fileWriter.js';
import { EventBroadcaster } from '../../routes/stream.js';
import { WRITE_MIGRATION_FILES_FUNCTION_ID } from '../../common/workspace-functions.js';
// WRITE_MIGRATION_FILES_FUNCTION_ID = 'write-migration-files' — SNS IDE exact value

export const writeMigrationFilesTool: ToolRequest = {
  id: WRITE_MIGRATION_FILES_FUNCTION_ID,
  name: 'write-migration-files',
  providerName: 'migration-output',
  description:
    'Writes multiple files to the modern output workspace in a single call. ' +
    'More efficient than calling write_file individually. ' +
    'Broadcasts a file_migrated SSE event for each file written.',
  parameters: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'Array of files to write.',
        items: {
          type: 'object',
          properties: {
            path:    { type: 'string', description: 'Relative destination path in the output workspace.' },
            content: { type: 'string', description: 'File content to write.' }
          },
          required: ['path', 'content']
        }
      }
    },
    required: ['files']
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { files: Array<{ path: string; content: string }> } = JSON.parse(arg_string || '{}');
    const written: string[] = [];
    const errors: string[] = [];
    for (const file of args.files) {
      try {
        await writeSessionFile(ctx!.modernPath, file.path, file.content);
        written.push(file.path);
        EventBroadcaster.broadcast(ctx!.sessionId, 'file_migrated', { file: file.path });
        ctx!.onLog?.(`Written: ${file.path}`, 'success');
      } catch (err: unknown) {
        const msg = (err as Error).message;
        errors.push(`${file.path}: ${msg}`);
        ctx!.onLog?.(`Failed to write ${file.path}: ${msg}`, 'error');
      }
    }
    return makeToolTextResult(JSON.stringify({ written, errors, totalWritten: written.length }));
  }
};

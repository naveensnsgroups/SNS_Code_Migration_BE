import { AIService } from '../ai/provider.js';
import { readSessionFile } from '../tools/fileReader.js';
import { writeSessionFile } from '../tools/fileWriter.js';

export interface ValidationError {
  filePath: string;
  line?: number;
  message: string;
}

export class ValidatorAgent {
  /**
   * Evaluates compilation or linting errors, applies AI adjustments to solve the issues,
   * and writes the corrected files back to the workspace.
   */
  static async resolveError(
    sessionId: string,
    modernPath: string,
    error: ValidationError,
    aiService: AIService,
    onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void
  ): Promise<void> {
    try {
      onLog?.(`Attempting to auto-resolve error in ${error.filePath}...`, 'info');
      onLog?.(`Error description: ${error.message}`, 'warning');

      let currentCode = '';
      try {
        currentCode = await readSessionFile(modernPath, error.filePath);
      } catch {
        onLog?.(`Skipping resolution: file ${error.filePath} could not be loaded.`, 'error');
        return;
      }

      const prompt = `You are a Senior Debugging Engineer.
We encountered a compilation/type/lint error in our modern codebase. We need to fix the file to resolve this issue.

FILE: ${error.filePath}
LINE NUMBER OF ERROR: ${error.line ?? 'Unknown'}
ERROR MESSAGE:
${error.message}

CURRENT FILE CONTENT:
\`\`\`
${currentCode}
\`\`\`

INSTRUCTIONS:
1. Fix the error. Ensure you maintain the correct logic.
2. Output ONLY the fixed complete code of the file. Do not include markdown code block syntax (like \`\`\`), conversational introductions, or explanations.
3. Make minimal changes to fix the error; keep the rest of the code as is.

Begin corrected code:`;

      onLog?.('Requesting bug fix from AI model...', 'info');
      const response = await aiService.generateCompletion(prompt, 'You are an automated code bug fixer.');
      let fixedCode = response.text.trim();

      if (fixedCode.startsWith('```')) {
        fixedCode = fixedCode.replace(/^```[a-zA-Z0-9+#]*\n/, '').replace(/```$/, '').trim();
      }

      await writeSessionFile(modernPath, error.filePath, fixedCode);
      onLog?.(`✅ Rewrote ${error.filePath} with AI-generated fix.`, 'success');
    } catch (err: any) {
      onLog?.(`❌ Failed to resolve error in ${error.filePath}: ${err.message}`, 'error');
      throw err;
    }
  }

  /**
   * Helper to parse compiler outputs (e.g. from TypeScript) and extract file paths & errors.
   */
  static parseTscOutput(stdout: string): ValidationError[] {
    const errors: ValidationError[] = [];
    const lines = stdout.split(/\r?\n/);
    
    // Regex for: src/index.ts(12,15): error TS2304: Cannot find name 'foo'.
    // or: src/index.ts:12:15 - error TS2304: Cannot find name 'foo'.
    const tscRegex1 = /^([^(]+)\((\d+),(\d+)\):\s+(error\s+[^:]+:\s+.*)$/;
    const tscRegex2 = /^([^:]+):(\d+):(\d+)\s+-\s+(error\s+[^:]+:\s+.*)$/;

    for (const line of lines) {
      let match = line.match(tscRegex1) || line.match(tscRegex2);
      if (match) {
        const rawFilePath = match[1].trim();
        // Skip paths that aren't source files (e.g. node_modules)
        if (rawFilePath.includes('node_modules')) continue;

        errors.push({
          filePath: rawFilePath,
          line: parseInt(match[2], 10),
          message: match[4].trim(),
        });
      }
    }

    return errors;
  }
}

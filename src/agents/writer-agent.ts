import { AIService } from '../ai/provider.js';
import { DetectedStack, TargetStack } from '../types.js';
import { readSessionFile } from '../tools/fileReader.js';
import { writeSessionFile } from '../tools/fileWriter.js';
import { FilePseudocode } from './pseudocode-agent.js';
import fs from 'fs-extra';
import path from 'path';

export class WriterAgent {
  /**
   * Migrates a single file from the legacy directory to the modern directory.
   */
  static async migrateFile(
    sessionId: string,
    legacyPath: string,
    modernPath: string,
    item: FilePseudocode,
    detectedStack: DetectedStack,
    targetStack: TargetStack,
    aiService: AIService,
    onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void
  ): Promise<void> {
    try {
      if (item.action === 'copy') {
        onLog?.(`Copying file ${item.path} unchanged to target...`, 'info');
        const srcPath = path.join(legacyPath, item.path);
        const destPath = path.join(modernPath, item.targetPath);
        await fs.ensureDir(path.dirname(destPath));
        await fs.copy(srcPath, destPath);
        return;
      }

      if (item.action === 'ignore' || item.action === 'delete') {
        onLog?.(`Skipping ignored file: ${item.path}`, 'info');
        return;
      }

      onLog?.(`Migrating ${item.path} → ${item.targetPath}...`, 'info');
      const legacyCode = await readSessionFile(legacyPath, item.path);

      const prompt = `You are an expert Software Engineer. You are refactoring/migrating the following legacy file to our modern stack.

LEGACY CODE (File: ${item.path}):
\`\`\`
${legacyCode}
\`\`\`

CONVERSION CONTEXT:
- Legacy Stack: ${detectedStack.language} (${detectedStack.framework})
- Target Stack: ${targetStack.language} (${targetStack.framework}) using ${targetStack.database} database
- Target File Path: ${item.targetPath}
- Refactoring Strategy: ${item.strategy}

INSTRUCTIONS:
1. Rewrite this file in the modern language & framework. Preserve 100% of the logic and behavior.
2. Use modern best practices (ESM imports, strict typing, async/await, proper try-catch).
3. Do not include any surrounding conversational text, markdown code blocks, or comments outside the source code.
4. Output ONLY the raw source code of the migrated file.

Begin migrated code:`;

      const response = await aiService.generateCompletion(prompt, 'You are an automated source-to-source code compiler.');
      let migratedCode = response.text.trim();

      // Clean up markdown block wrapping if present
      if (migratedCode.startsWith('```')) {
        migratedCode = migratedCode.replace(/^```[a-zA-Z0-9+#]*\n/, '').replace(/```$/, '').trim();
      }

      await writeSessionFile(modernPath, item.targetPath, migratedCode);
      onLog?.(`✅ Migrated ${item.path}`, 'success');
    } catch (err: any) {
      onLog?.(`❌ Failed to migrate ${item.path}: ${err.message}`, 'error');
      throw err;
    }
  }
}

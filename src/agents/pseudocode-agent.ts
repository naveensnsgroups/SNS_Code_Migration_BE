import { AIService } from '../ai/provider.js';
import { DetectedStack, TargetStack } from '../types.js';
import { readSessionFile } from '../tools/fileReader.js';
import { writeSessionFile } from '../tools/fileWriter.js';

export interface FilePseudocode {
  path: string;
  action: 'migrate' | 'create' | 'copy' | 'delete' | 'ignore';
  targetPath: string;
  strategy: string;
}

export class PseudocodeAgent {
  /**
   * Generates a pseudocode conversion strategy json mapping for files.
   */
  static async run(
    sessionId: string,
    legacyPath: string,
    modernPath: string,
    detectedStack: DetectedStack,
    targetStack: TargetStack,
    fileList: string[],
    aiService: AIService,
    onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void
  ): Promise<FilePseudocode[]> {
    onLog?.('Planning code conversions for each file...', 'info');

    // Create a compact list of files to fit within model contexts
    const fileEntries = fileList.map(f => ({
      path: f,
      type: f.match(/\.(js|py|java|php|rb|ts)$/i) ? 'source_code' : 'other',
    }));

    const prompt = `You are a Lead Refactoring Engineer.
We need to generate a JSON migration map listing every source file and what modernization strategy to apply.

SOURCE STACK: ${detectedStack.language} / ${detectedStack.framework}
TARGET STACK: ${targetStack.language} / ${targetStack.framework} (using Test framework: ${targetStack.testFramework})

FILES LIST:
${JSON.stringify(fileEntries, null, 2)}

Produce a JSON array conforming exactly to this TypeScript interface:
interface FilePseudocode {
  path: string; // original relative path
  action: 'migrate' | 'copy' | 'delete' | 'ignore'; // action to take
  targetPath: string; // modern file path (convert extensions, e.g. .js -> .ts, .py -> .ts)
  strategy: string; // 1-sentence code rewrite strategy (e.g. "Convert CommonJS require to ESM, replace sqlite3 with sqlite package, define TypeScript interfaces for requests")
}

Return ONLY the raw JSON array. Do not include markdown code fence formatting (like \`\`\`json). Output valid JSON only.`;

    onLog?.('Requesting pseudocode mapping from AI...', 'info');
    const response = await aiService.generateCompletion(prompt, 'You are an automated refactoring coordinator.');
    
    // Clean up code block markers if AI includes them
    let jsonText = response.text.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(json)?/, '').replace(/```$/, '').trim();
    }

    try {
      const roadmap: FilePseudocode[] = JSON.parse(jsonText);
      onLog?.(`Successfully generated pseudocode strategies for ${roadmap.length} items.`, 'success');
      await writeSessionFile(modernPath, 'pseudocode.json', JSON.stringify(roadmap, null, 2));
      return roadmap;
    } catch (err: any) {
      onLog?.(`JSON parsing of pseudocode mapping failed: ${err.message}. Creating fallback strategy.`, 'warning');
      
      // Fallback Strategy
      const fallbackRoadmap: FilePseudocode[] = fileList.map(f => {
        const isSrc = !!f.match(/\.(js|py|java|php|rb)$/i);
        const targetExt = targetStack.language === 'TypeScript' ? '.ts' : path.extname(f);
        const targetPath = isSrc ? f.replace(/\.[^/.]+$/, targetExt) : f;
        
        return {
          path: f,
          action: isSrc ? 'migrate' : 'copy',
          targetPath,
          strategy: isSrc ? `Migrate ${detectedStack.language} to modern ${targetStack.language} and framework.` : 'Copy file unchanged.',
        };
      });

      await writeSessionFile(modernPath, 'pseudocode.json', JSON.stringify(fallbackRoadmap, null, 2));
      return fallbackRoadmap;
    }
  }
}
import path from 'path';

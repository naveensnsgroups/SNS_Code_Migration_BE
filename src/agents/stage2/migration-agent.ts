// Facade preserving the MigrationAgent.runX(...) call shape stage2-routes.ts
// already uses. Each sub-stage's actual logic lives in its own runner file
// under runners/ — this class just delegates.
import { DetectedStack, TargetStack } from '../../types.js';
import { LogFn } from './runners/shared.js';
import { runPlanning }        from './runners/migration-planning-runner.js';
import { runCodeGeneration }  from './runners/code-generation-runner.js';
import { runVerification }    from './runners/verification-runner.js';

export class MigrationAgent {
  static runPlanning(
    sessionId:     string,
    legacyPath:    string,
    modernPath:    string,
    detectedStack: DetectedStack,
    targetStack:   TargetStack,
    onLog?:        LogFn,
    onProgress?:   (percent: number) => void,
  ): Promise<void> {
    return runPlanning(sessionId, legacyPath, modernPath, detectedStack, targetStack, onLog, onProgress);
  }

  static runCodeGeneration(
    sessionId:       string,
    legacyPath:      string,
    modernPath:      string,
    detectedStack:   DetectedStack,
    targetStack:     TargetStack,
    onLog?:          LogFn,
    onProgress?:     (percent: number) => void,
    onFileGenerated?: (targetFile: string) => void,
  ): Promise<void> {
    return runCodeGeneration(sessionId, legacyPath, modernPath, detectedStack, targetStack, onLog, onProgress, onFileGenerated);
  }

  static runVerification(
    sessionId:     string,
    legacyPath:    string,
    modernPath:    string,
    detectedStack: DetectedStack,
    targetStack:   TargetStack,
    onLog?:        LogFn,
    onProgress?:   (percent: number) => void,
  ): Promise<void> {
    return runVerification(sessionId, legacyPath, modernPath, detectedStack, targetStack, onLog, onProgress);
  }
}

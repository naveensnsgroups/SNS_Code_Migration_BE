// =============================================================================
//  google/gemini-service.ts — Barrel re-export
//
//  SNS IDE folder structure:
//    src/ai/google/
//      gemini-language-model.ts  ← actual implementation (GeminiProvider + GeminiService)
//      gemini-service.ts         ← this file: named re-exports for clean imports
//
//  External code should import from here, not directly from gemini-language-model.ts
// =============================================================================

export {
  GeminiProvider,
  GeminiService,
  type GeminiProviderConfig,
} from './gemini-language-model.js';

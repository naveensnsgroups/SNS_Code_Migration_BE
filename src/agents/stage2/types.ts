

// Task-list entry produced by MIGRATION_PLANNER_AGENT for one legacy file.
// dependsOn/legacyFile values are the same relative-path keys used across
// imports-graph / symbol-graph / rule-graph, so they can be cross-referenced
// directly against Stage 1 output without any translation.
export interface MigrationTaskEntry {
  legacyFile:    string;
  targetFile:    string;
  rulesInvolved: string[];   // rule-graph descriptions relevant to this file
  dependsOn:     string[];   // other legacyFile paths that must be migrated first
  status:        'pending' | 'generated' | 'verified' | 'failed';
  lastError?:    string;
  // Other legacyFile paths the Planner also assigned to this SAME targetFile
  // (e.g. add_task.cbl + delete_task.cbl + list_task.cbl all -> tasks.py).
  // Generation writes ONE target file per task, so a collision like this MUST
  // be merged into a single task that translates every one of these files
  // together — never split across multiple write_file calls to the same path,
  // which would just have each one silently overwrite the last.
  mergedLegacyFiles?: string[];
  // Real exported symbols (name + async-ness), extracted deterministically
  // from this task's generated content once it passes the stub check — fed
  // into a dependent file's prompt as real signature info instead of just a
  // path, so it doesn't have to guess whether an import is async. See
  // symbol-extraction.ts.
  exportedSymbols?: { name: string; isAsync: boolean }[];
  // Real error text from each past regeneration-fix attempt during
  // Verification, oldest first — fed into the next attempt's prompt as full
  // history (not just the latest error) so a later attempt doesn't blindly
  // repeat something already proven not to work. Reset to undefined at the
  // start of a fresh Code Generation pass (see code-generation-runner.ts) —
  // history from a previous file version is meaningless once that content
  // has been overwritten.
  fixAttempts?: string[];
}

// Per-file business-rule coverage, checked after CODE_GENERATOR_AGENT writes
// the target file — the mechanism that catches a passing build which quietly
// dropped a business rule.
export interface RuleCoverageEntry {
  legacyFile: string;
  targetFile: string;
  rules:      string[];   // expected — from the task entry's rulesInvolved
  covered?:   string[];   // confirmed present after generation
  uncovered?: string[];   // confirmed missing after generation — hard failure
}

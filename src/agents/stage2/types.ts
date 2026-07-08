

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

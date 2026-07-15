// Framework Skill files — curated, per-target-framework conventions that get
// spliced into the Migration Planner's and Code Generator's existing prompts.
// See src/knowledge/framework-skills/*.md for the actual content; this file is
// just the shape the loader parses those .md files into.
//
// This is deliberately NOT Claude's Agent Skill format (name/description +
// Instructions/Examples) — that format exists to let an agent autonomously
// discover the right skill among many via bash + a live filesystem VM. Here,
// our own code already knows exactly which skill it wants (targetStack.framework
// is a known, structured value) — no discovery step needed. Exact/alias lookup
// (framework/aliases) plus named, independently-injectable sections (each
// pipeline stage needs a different subset) fits this problem better than the
// Claude Skill shape would.

export interface ScaffoldingFile {
  id:               string;             // e.g. 'entrypoint', 'db-connection'
  order:            'first' | 'last';   // first = everyone may depend on it; last = it depends on everyone
  targetFileHint:   string;             // e.g. 'app/main.py' — a default; adjusted to the majority directory at build time
  purpose:          string;             // one-line description surfaced in logs/HITL
  generationBrief:  string;             // instructions for the code-generator's infra-generation branch
}

export interface FrameworkSkill {
  frameworkNames:   string[];  // aliases this skill matches against targetStack.framework, e.g. ['fastapi', 'fast api', 'fast-api']
  language:         string;    // informational — the language this skill assumes (e.g. 'python')
  version:          number;    // informational — not yet consumed by any compatibility logic
  folderLayout:     string;    // injected into the Planner's prompt
  routerPattern:    string;    // injected into the Generator's prompt
  diPattern:        string;    // injected into the Generator's prompt
  asyncConventions: string;    // injected into the Generator's prompt
  scaffolding:      ScaffoldingFile[];
  sourceFile:       string;    // absolute path this skill was loaded from — for warnings/diagnostics
}



// Deterministic cross-file reference check — no LLM, no shell execution.
//
// This targets the exact failure mode found in real generated output: a file
// imports a sibling migrated file using a GUESSED module name/path instead of
// the one the Migration Planner actually assigned it (e.g. importing
// "app.controllers.user_controller" when the real generated file is
// "app/controllers/user.py"). Each file is generated in its own isolated
// turn, so it has no way to see what a sibling file's final content looked
// like — only the Planner's task list knows every file's real target path.
//
// This is NOT a substitute for real build/execute verification (catching
// missing third-party dependencies, logic errors, runtime exceptions) — that
// requires an actual installed toolchain for the user's chosen target stack,
// which the platform does not provision. This check is what's reliably
// available without one: does the generated file's own content actually
// reference the correct path for each file it depends on.

// Produces every plausible substring form a target path could appear as
// inside generated source — dotted module notation, slash notation, and
// each trailing suffix of both (so a file two directories deep can still
// match a shorter relative import).
function deriveModuleReferenceCandidates(targetFile: string): string[] {
  const noExt = targetFile.replace(/\.[^./]+$/, '');
  const parts = noExt.split('/').filter(Boolean);
  const candidates = new Set<string>();

  for (let i = 0; i < parts.length; i++) {
    const suffixParts = parts.slice(i);
    candidates.add(suffixParts.join('/'));
    candidates.add(suffixParts.join('.'));
  }
  // The bare filename alone (e.g. "user") is too common to be meaningful on
  // its own — require at least one directory segment for a real match.
  for (const c of [...candidates]) {
    if (!c.includes('/') && !c.includes('.')) candidates.delete(c);
  }
  return [...candidates];
}

// Best-effort, language-agnostic comment stripping — # to end of line
// (Python/Ruby/shell/YAML) and // to end of line (JS/TS/Java/Go/C#/Rust).
// Without this, a reference that only appears inside a COMMENTED-OUT import
// (e.g. "# from app.routes.user import ...") reads as "present" even though
// it does nothing — which is exactly the stub-hiding pattern found in a real
// run (an entrypoint that commented out every router registration "for a
// future step" while still containing the literal correct import string).
function stripLineComments(content: string): string {
  return content
    .split('\n')
    .map(line => line.replace(/#.*$/, '').replace(/\/\/.*$/, ''))
    .join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function checkCrossFileReferences(
  content:           string,
  dependencyTargets: string[]
): string[] {
  const codeOnly = stripLineComments(content);
  const unresolved: string[] = [];

  for (const depTarget of dependencyTargets) {
    const candidates = deriveModuleReferenceCandidates(depTarget);
    // Word-boundary aware: a candidate "app.controllers.user" must NOT match
    // inside "app.controllers.user_controller" — \b alone doesn't stop that
    // (underscore is a word character), so require the next character (if
    // any) to NOT be a word character or a slash/dot continuation.
    const found = candidates.length > 0 && candidates.some(c => {
      const pattern = new RegExp(`(?<![\\w./])${escapeRegExp(c)}(?![\\w])`);
      return pattern.test(codeOnly);
    });
    if (!found) unresolved.push(depTarget);
  }
  return unresolved;
}

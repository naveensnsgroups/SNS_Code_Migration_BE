// Deterministic, regex-based extraction of a generated file's real top-level
// exported symbols (function/class names, and whether each is async) — same
// philosophy as verification.ts's deriveModuleReferenceCandidates: no LLM
// self-report (which could itself hallucinate what it wrote), just a direct
// scan of the actual content.
//
// This is a generation-time AID, not a verification GATE — it gives a
// dependent file real signature info to write against (so it doesn't have to
// guess whether an import is async), directly preventing the class of bug
// proven in a real run: `db = get_db()` where get_db is `async def`, because
// the caller had no signal it needed `await`. The actual enforcement — did
// the file get this right — belongs to Workstream 3's sandboxed real-toolchain
// check, not a hand-rolled parser here.
export interface ExportedSymbol {
  name:    string;
  isAsync: boolean;
}

function extractPython(content: string): ExportedSymbol[] {
  const symbols: ExportedSymbol[] = [];
  const seen = new Set<string>();
  // Top-level only (no leading whitespace) — a method nested inside a class
  // isn't something another file imports directly by that bare name.
  for (const match of content.matchAll(/^(async\s+)?def\s+(\w+)\s*\(/gm)) {
    const [, asyncKeyword, name] = match;
    if (seen.has(name)) continue;
    seen.add(name);
    symbols.push({ name, isAsync: !!asyncKeyword });
  }
  for (const match of content.matchAll(/^class\s+(\w+)\s*[:(]/gm)) {
    const [, name] = match;
    if (seen.has(name)) continue;
    seen.add(name);
    symbols.push({ name, isAsync: false });
  }
  return symbols;
}

function extractJsTs(content: string): ExportedSymbol[] {
  const symbols: ExportedSymbol[] = [];
  const seen = new Set<string>();

  const add = (name: string, isAsync: boolean) => {
    if (seen.has(name)) return;
    seen.add(name);
    symbols.push({ name, isAsync });
  };

  for (const [, asyncKeyword, name] of content.matchAll(/^export\s+(async\s+)?function\s+(\w+)\s*\(/gm)) {
    add(name, !!asyncKeyword);
  }
  for (const [, name] of content.matchAll(/^export\s+(?:default\s+)?class\s+(\w+)\b/gm)) {
    add(name, false);
  }
  // export const foo = async (...) => ...  |  export const foo = (...) => ...
  for (const [, name, asyncKeyword] of content.matchAll(/^export\s+const\s+(\w+)\s*=\s*(async\s+)?\(/gm)) {
    add(name, !!asyncKeyword);
  }
  return symbols;
}

// Java/Go/etc. don't share Python/JS's async-function-declaration idiom in a
// way a regex can reliably classify (Java uses CompletableFuture/reactive
// types, Go uses goroutines+channels) — returning an empty list here is
// honest: "no signal available" rather than a guessed, likely-wrong isAsync.
export function extractExportedSymbols(content: string, language: string): ExportedSymbol[] {
  const lang = (language || '').toLowerCase();
  if (lang.includes('python')) return extractPython(content);
  if (lang.includes('typescript') || lang.includes('javascript')) return extractJsTs(content);
  return [];
}

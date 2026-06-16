// =============================================================================
//  compactor/agent-cost-estimator.ts
//
//  Per-provider API cost estimation for token usage tracking.
//
//  Responsibility: Given input/output token counts and a model name,
//  estimate the USD cost of an API call.
//
//  Used by:
//    - agentExecutor.ts      (imported indirectly via sessionManager)
//    - sessionManager.ts     (dynamic import on every token usage record)
//
//  WHY a separate file:
//    Cost estimation is a shared utility — not specific to the agent loop.
//    Keeping it here avoids coupling sessionManager → agentExecutor.
// =============================================================================

// ── Per-provider cost table (USD per 1M tokens) ───────────────────────────────
//
// Keys use substring matching (model.includes(key)) so future model versions
// (e.g. "claude-sonnet-4-6") automatically match the nearest entry.
// The 'default' key is the fallback for any unknown model.
//
// Pricing source: provider official pricing pages (as of 2026).
// Update this table when providers change pricing — no code changes needed elsewhere.

export const COST_TABLE: Record<string, [number, number]> = {
  // ── Anthropic / Claude ──────────────────────────────────────────────────────
  'claude-opus-4':      [15,    75   ],
  'claude-opus-4-5':    [15,    75   ],
  'claude-sonnet-4':    [3,     15   ],
  'claude-sonnet-4-5':  [3,     15   ],
  'claude-3-5-sonnet':  [3,     15   ],
  'claude-3-opus':      [15,    75   ],
  'claude-3-haiku':     [0.25,  1.25 ],

  // ── OpenAI / GPT ────────────────────────────────────────────────────────────
  'gpt-4o':             [2.5,   10   ],
  'gpt-4o-mini':        [0.15,  0.6  ],
  'gpt-4-turbo':        [10,    30   ],
  'gpt-3.5-turbo':      [0.5,   1.5  ],

  // ── Google / Gemini ─────────────────────────────────────────────────────────
  'gemini-2.5-pro':     [1.25,  10   ],
  'gemini-2.0-flash':   [0.075, 0.3  ],
  'gemini-1.5-pro':     [1.25,  5    ],
  'gemini-1.5-flash':   [0.075, 0.3  ],

  // ── Fallback ─────────────────────────────────────────────────────────────────
  'default':            [1,     3    ],  // safe mid-range default
};

/**
 * Estimates the USD cost of an API call from token counts and model name.
 *
 * Uses substring matching (model.includes(key)) so it works for any model
 * variant without requiring an exact name match.
 * Falls back to 'default' pricing for unknown models.
 *
 * @param inputTokens   Prompt tokens used in this call
 * @param outputTokens  Completion tokens generated in this call
 * @param model         Model identifier (e.g. "gemini-2.5-flash", "claude-3-haiku")
 * @returns             Estimated USD cost (rounded to 4 decimal places)
 *
 * @example
 *   estimateCost(10_000, 2_000, 'gemini-2.0-flash')
 *   // → 0.0013 USD
 */
export function estimateCost(
  inputTokens:  number,
  outputTokens: number,
  model:        string
): number {
  const entry = Object.entries(COST_TABLE).find(([key]) =>
    key !== 'default' && model.toLowerCase().includes(key)
  );
  const [inCostPerM, outCostPerM] = entry ? entry[1] : COST_TABLE['default'];
  const cost = (inputTokens / 1_000_000) * inCostPerM
             + (outputTokens / 1_000_000) * outCostPerM;
  return Math.round(cost * 10_000) / 10_000;
}

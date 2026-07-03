

export const COST_TABLE: Record<string, [number, number]> = {
  
  'claude-opus-4':      [15,    75   ],
  'claude-opus-4-5':    [15,    75   ],
  'claude-sonnet-4':    [3,     15   ],
  'claude-sonnet-4-5':  [3,     15   ],
  'claude-3-5-sonnet':  [3,     15   ],
  'claude-3-opus':      [15,    75   ],
  'claude-3-haiku':     [0.25,  1.25 ],

  
  'gpt-4o':             [2.5,   10   ],
  'gpt-4o-mini':        [0.15,  0.6  ],
  'gpt-4-turbo':        [10,    30   ],
  'gpt-3.5-turbo':      [0.5,   1.5  ],

  
  'gemini-2.5-pro':     [1.25,  10   ],
  'gemini-2.0-flash':   [0.075, 0.3  ],
  'gemini-1.5-pro':     [1.25,  5    ],
  'gemini-1.5-flash':   [0.075, 0.3  ],

  
  'default':            [1,     3    ],  
};

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

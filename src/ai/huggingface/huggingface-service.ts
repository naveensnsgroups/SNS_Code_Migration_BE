

import { AIService, AICompletionResponse } from '../provider.js';

export class HuggingFaceService implements AIService {
  private apiKey: string;
  private model: string;

  constructor(model: string, apiKey: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generateCompletion(prompt: string, systemPrompt?: string): Promise<AICompletionResponse> {
    try {
      const formattedPrompt = systemPrompt
        ? `${systemPrompt}\n\nUser: ${prompt}\nAssistant:`
        : prompt;

      const response = await fetch(`https://api-inference.huggingface.co/models/${this.model}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          inputs: formattedPrompt,
          parameters: {
            max_new_tokens: 2048,
            return_full_text: false,
          }
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HF API response status ${response.status}: ${errText}`);
      }

      const data = await response.json();

      let text = '';
      if (Array.isArray(data) && data[0]?.generated_text) {
        text = data[0].generated_text;
      } else if (data.generated_text) {
        text = data.generated_text;
      } else {
        text = typeof data === 'string' ? data : JSON.stringify(data);
      }

      return {
        text,
        usage: {
          promptTokens: Math.ceil(formattedPrompt.length / 4),
          completionTokens: Math.ceil(text.length / 4),
        },
      };
    } catch (err: any) {
      console.error('[Hugging Face Service Error]:', err);
      throw new Error(`Hugging Face API request failed: ${err.message}`);
    }
  }
}

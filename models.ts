import axios from "axios";

// Enum definitions based on the provided code
export enum RequestyAiModelEnum {
  claude37Sonnet = "anthropic/claude-3-7-sonnet-latest",
  geminiFlash2 = "google/gemini-2.0-flash-001",
  deepSeekV3 = "nebius/deepseek-ai/DeepSeek-V3-0324",
  gemini25Pro = "google/gemini-2.5-pro-exp-03-25",
}

export enum OpenRouterAiModelEnum {
  llama4Maverick = "meta-llama/llama-4-maverick",
  geminiFlash2 = "google/gemini-2.0-flash-001",
}

export type AiModelEnum = RequestyAiModelEnum | OpenRouterAiModelEnum;

export interface ChatMessage {
  role: string;
  content: string;
}

export class ModelRouter {
  private model: AiModelEnum;
  private requestyBaseUrl: string =
    "https://router.requesty.ai/v1/chat/completions";
  private openRouterBaseUrl: string =
    "https://openrouter.ai/api/v1/chat/completions";

  constructor(model: AiModelEnum) {
    this.model = model;
  }

  public async sendToModel(messages: ChatMessage[]): Promise<string> {
    // if this is a Requesty model, send to Requesty
    if (
      Object.values(RequestyAiModelEnum).includes(
        this.model as RequestyAiModelEnum
      )
    ) {
      return this.sendToRequesty(messages, this.model as RequestyAiModelEnum);
    }

    return this.sendToOpenRouter(messages, this.model as OpenRouterAiModelEnum);
  }

  private async sendToRequesty(
    messages: ChatMessage[],
    model: RequestyAiModelEnum
  ): Promise<string> {
    try {
      const requestPayload = {
        model,
        messages,
        temperature: 0,
        requesty: {
          user_id: "EvaluateGPT",
          extra: {
            title: "EvaluateGPT",
          },
        },
      };

      const apiKey = process.env.REQUESTY_API_KEY;

      if (!apiKey) {
        throw new Error("REQUESTY_API_KEY is not set");
      }

      const headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };

      const response = await axios.post(this.requestyBaseUrl, requestPayload, {
        headers,
      });

      if (!response.data.choices[0].message?.content) {
        throw new Error("No content in Requesty response");
      }

      return response.data.choices[0].message.content;
    } catch (error: any) {
      console.error(
        "Error sending prompt to Requesty:",
        error?.response?.data || error
      );
      throw error;
    }
  }

  private async sendToOpenRouter(
    messages: ChatMessage[],
    model: OpenRouterAiModelEnum
  ): Promise<string> {
    try {
      const requestPayload = {
        model,
        messages,
        temperature: 0,
        user: "EvaluateGPT",
      };

      const apiKey = process.env.OPENROUTER_API_KEY;

      if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is not set");
      }

      const headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://evaluategpt.com",
        "X-Title": "EvaluateGPT",
      };

      const response = await axios.post(
        this.openRouterBaseUrl,
        requestPayload,
        {
          headers,
        }
      );

      if (!response.data.choices[0].message?.content) {
        throw new Error("No content in OpenRouter response");
      }

      return response.data.choices[0].message.content;
    } catch (error: any) {
      console.error(
        "Error sending prompt to OpenRouter:",
        error?.response?.data || error
      );
      throw error;
    }
  }
}

import axios, { AxiosError } from "axios";

const getTemperature = (model: AiModelEnum): number => {
  const modelsWhereTemperatureIs1 = [
    OpenRouterAiModelEnum.o3,
    RequestyAiModelEnum.o3Mini,
    RequestyAiModelEnum.o4Mini,
  ];
  if (modelsWhereTemperatureIs1.includes(model as RequestyAiModelEnum)) {
    return 1;
  }
  return 0;
};

// Enum definitions based on the provided code
export enum RequestyAiModelEnum {
  claude37Sonnet = "anthropic/claude-3-7-sonnet-latest",
  geminiFlash2 = "google/gemini-2.0-flash-001",
  deepSeekV3 = "nebius/deepseek-ai/DeepSeek-V3-0324",
  deepSeekR1 = "deepinfra/deepseek-ai/DeepSeek-R1",
  gpt4o = "openai/gpt-4o",
  gemini25Pro = "google/gemini-2.5-pro-exp-03-25",
  grok3Mini = "xai/grok-3-mini-beta",
  grok3 = "xai/grok-3-beta",
  o3Mini = "openai/o3-mini",
  gpt4One = "openai/gpt-4.1-2025-04-14",
  gpt4OneMini = "openai/gpt-4.1-mini-2025-04-14",
  gpt4OneNano = "openai/gpt-4.1-nano-2025-04-14",
  o4Mini = "openai/o4-mini-2025-04-16",
  o4MiniLow = "openai/o4-mini:low",
  o4MiniHigh = "openai/o4-mini:high",
  claudeOpus4 = "anthropic/claude-opus-4-20250514",
  claudeSonnet4 = "vertex/anthropic/claude-4-sonnet",
}

export enum OpenRouterAiModelEnum {
  llama4Maverick = "meta-llama/llama-4-maverick",
  geminiFlash2 = "google/gemini-2.0-flash-001",
  gpt4o = "openai/gpt-4o",
  gemini25FlashMay = "google/gemini-2.5-flash-preview-05-20",
  gemini25FlashMayThinking = "google/gemini-2.5-flash-preview-05-20:thinking",
  gemini25Pro = "google/gemini-2.5-pro-preview-03-25",
  gemini25ProMay = "google/gemini-2.5-pro-preview",
  claude37SonnetThinking = "anthropic/claude-3.7-sonnet:thinking",
  deepseekProverV2 = "deepseek/deepseek-prover-v2",
  grok4 = "x-ai/grok-4-07-09",
  o3 = "openai/o3-2025-04-16",
  horizonAlpha = "openrouter/horizon-alpha",
}

export type AiModelEnum = RequestyAiModelEnum | OpenRouterAiModelEnum;

export interface ChatMessage {
  role: string;
  content: string;
}

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export class ModelRouter {
  private model: AiModelEnum;
  private requestyBaseUrl: string =
    "https://router.requesty.ai/v1/chat/completions";
  private openRouterBaseUrl: string =
    "https://openrouter.ai/api/v1/chat/completions";
  private retryOptions: RetryOptions;

  constructor(model: AiModelEnum, retryOptions: Partial<RetryOptions> = {}) {
    this.model = model;
    // Default retry options with sensible defaults
    this.retryOptions = {
      maxRetries: 10,
      initialDelayMs: 4000,
      maxDelayMs: 30000,
      backoffFactor: 2,
      ...retryOptions,
    };
  }

  /**
   * Send messages to the appropriate AI model with retry functionality
   */
  public async sendToModel(messages: ChatMessage[]): Promise<string> {
    // if this is a Requesty model, send to Requesty
    if (
      Object.values(OpenRouterAiModelEnum).includes(
        this.model as OpenRouterAiModelEnum
      )
    ) {
      return this.sendWithRetry(() =>
        this.sendToOpenRouter(messages, this.model as OpenRouterAiModelEnum)
      );
    }

    return this.sendWithRetry(() =>
      this.sendToRequesty(messages, this.model as RequestyAiModelEnum)
    );
  }

  /**
   * Generic retry wrapper for API calls
   */
  private async sendWithRetry(
    apiCallFn: () => Promise<string>
  ): Promise<string> {
    let retryCount = 0;
    let delay = this.retryOptions.initialDelayMs;

    while (true) {
      try {
        return await apiCallFn();
      } catch (error: any) {
        const axiosError = error as AxiosError;
        const statusCode = axiosError.response?.status;

        // Check if we've exceeded max retries or if the error is not retryable
        if (retryCount >= this.retryOptions.maxRetries) {
          // Log and rethrow for non-retryable errors or max retries reached
          console.error(
            `Failed after ${retryCount} retries:`,
            axiosError?.response?.data || error
          );
          throw error;
        }

        // Log retry attempt
        retryCount++;
        console.warn(
          `Request failed with status ${statusCode}. Retrying (${retryCount}/${this.retryOptions.maxRetries}) after ${delay}ms...`
        );

        // Wait before next retry
        await new Promise((resolve) => setTimeout(resolve, delay));

        // Calculate next delay with exponential backoff, capped at maxDelayMs
        delay = Math.min(
          delay * this.retryOptions.backoffFactor,
          this.retryOptions.maxDelayMs
        );
      }
    }
  }

  /**
   * Send messages to the Requesty API
   */
  private async sendToRequesty(
    messages: ChatMessage[],
    model: RequestyAiModelEnum
  ): Promise<string> {
    try {
      const requestPayload = {
        model,
        messages,
        temperature: getTemperature(model),
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

  /**
   * Send messages to the OpenRouter API
   */
  private async sendToOpenRouter(
    messages: ChatMessage[],
    model: OpenRouterAiModelEnum
  ): Promise<string> {
    try {
      const requestPayload = {
        model,
        messages,
        temperature: getTemperature(model),
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

      if (!response.data.choices?.[0]?.message?.content) {
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

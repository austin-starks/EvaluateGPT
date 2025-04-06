import axios, { AxiosError } from "axios";

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
  gpt4o = "openai/gpt-4o",
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
  retryableStatusCodes: number[];
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
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      backoffFactor: 2,
      retryableStatusCodes: [408, 429, 500, 502, 503, 504],
      ...retryOptions,
    };
  }

  /**
   * Send messages to the appropriate AI model with retry functionality
   */
  public async sendToModel(messages: ChatMessage[]): Promise<string> {
    // if this is a Requesty model, send to Requesty
    if (
      Object.values(RequestyAiModelEnum).includes(
        this.model as RequestyAiModelEnum
      )
    ) {
      return this.sendWithRetry(() =>
        this.sendToRequesty(messages, this.model as RequestyAiModelEnum)
      );
    }

    return this.sendWithRetry(() =>
      this.sendToOpenRouter(messages, this.model as OpenRouterAiModelEnum)
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
        if (
          retryCount >= this.retryOptions.maxRetries ||
          (statusCode &&
            !this.retryOptions.retryableStatusCodes.includes(statusCode))
        ) {
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

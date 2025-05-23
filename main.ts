import {
  AiModelEnum,
  ChatMessage,
  ModelRouter,
  OpenRouterAiModelEnum,
  RequestyAiModelEnum,
} from "./models";

import { BigQuery } from "@google-cloud/bigquery";
import { createObjectCsvWriter } from "csv-writer";
import dotenv from "dotenv";
import { evaluationPrompt } from "./systemPrompts/evaluationPrompt";
import fs from "fs";
import path from "path";
import { questions } from "./questions";
import { systemPrompt } from "./systemPrompts/systemPrompt";

// Load environment variables
dotenv.config();

// Types
interface QueryResponse {
  content: string;
  sql?: string;
}

interface EvaluationResult {
  value: number;
  explanation: string;
  model: AiModelEnum;
}

interface QuestionResult {
  question: string;
  sql: string;
  score: number;
  explanation: string;
  resultCount: number;
  executionTimeMs: number;
  errorOccurred: boolean;
  errorMessage?: string;
}

interface AggregateStatistics {
  averageScore: number;
  medianScore: number;
  minScore: number;
  maxScore: number;
  standardDeviation: number;
  executionSuccessRate: number;
  averageExecutionTimeMs: number;
  scoreDistribution: {
    "0.0-0.2": number;
    "0.3-0.5": number;
    "0.6-0.7": number;
    "0.8-0.9": number;
    "1.0": number;
  };
}

class BatchSQLEvaluator {
  private systemPrompt: string;
  private evaluationPrompt: string;
  private queryModel: AiModelEnum;
  private evaluationModels: AiModelEnum[];
  private bigquery: BigQuery;
  private questions: string[];
  private results: QuestionResult[] = [];

  constructor({
    systemPrompt,
    evaluationPrompt,
    queryModel,
    evaluationModels,
    questions,
  }: {
    systemPrompt: string;
    evaluationPrompt: string;
    queryModel: AiModelEnum;
    evaluationModels: AiModelEnum[];
    questions: string[];
  }) {
    this.systemPrompt = systemPrompt;
    this.evaluationPrompt = evaluationPrompt;
    this.queryModel = queryModel;
    this.evaluationModels = evaluationModels;
    this.questions = questions;

    // Initialize BigQuery with credentials from environment variable
    const credentials = this.setupCredentials();
    this.bigquery = new BigQuery({ credentials });
  }

  private setupCredentials() {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!credentialsJson) {
      throw new Error(
        "GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable is not set"
      );
    }
    try {
      return JSON.parse(credentialsJson);
    } catch (error) {
      throw new Error("Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON");
    }
  }

  /**
   * Helper function to parse JSON from a model response
   * @param responseText The raw text response from the model
   * @returns Parsed JSON object
   */
  private parseModelResponse(responseText: string): any {
    // Try to extract JSON from the response
    const jsonMatch =
      responseText.match(/```json\n([\s\S]*?)\n```/) ||
      responseText.match(/{[\s\S]*?}/);

    let jsonText = jsonMatch ? jsonMatch[1] || jsonMatch[0] : responseText;

    // Clean up the JSON if necessary
    if (!jsonText.startsWith("{")) {
      jsonText = "{" + jsonText.split("{").slice(1).join("{");
    }

    return JSON.parse(jsonText);
  }

  /**
   * Helper function to retry an operation with exponential backoff
   * @param operation The async operation to retry
   * @param maxRetries Maximum number of retry attempts
   * @param operationName Name of the operation for logging
   * @returns Result of the operation
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    operationName: string = "operation"
  ): Promise<T> {
    let retryCount = 0;
    let lastError: any = null;

    while (retryCount < maxRetries) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        retryCount++;
        console.error(
          `Error in ${operationName} (attempt ${retryCount}/${maxRetries}):`,
          error
        );

        if (retryCount < maxRetries) {
          console.log(`Retrying ${operationName}...`);
          // Add a small delay between retries to avoid rate limiting
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * retryCount)
          );
        } else {
          console.error(
            `Failed to complete ${operationName} after ${maxRetries} attempts. Last error:`,
            lastError
          );
          throw new Error(
            `Failed to complete ${operationName} after ${maxRetries} attempts`
          );
        }
      }
    }

    // This should never be reached due to the throw in the catch block
    throw lastError;
  }

  private extractSQL(content: string): QueryResponse {
    // Check for both ```sql and plain ``` code blocks
    const sqlMatch = content.match(/```(?:sql)?\n([\s\S]*?)```/);

    if (sqlMatch) {
      return {
        content: content.replace(/```(?:sql)?\n[\s\S]*?```/, "").trim(),
        sql: sqlMatch[1].trim(),
      };
    }
    return {
      content: content,
    };
  }

  private async executeQuery(sql: string): Promise<any[]> {
    try {
      const options = {
        query: sql,
        location: "US",
        maximumBytesBilled: "1000000000", // 1GB limit to prevent runaway queries
      };
      const [job] = await this.bigquery.createQueryJob(options);
      console.log(`Job ${job.id} started.`);
      const [rows] = await job.getQueryResults();

      return rows;
    } catch (error) {
      console.error("Error executing BigQuery:", sql);
      console.error(error);
      throw error;
    }
  }

  private async evaluateResults(
    sql: string,
    thoughtProcess: string,
    results: any[]
  ): Promise<EvaluationResult> {
    // Create the evaluation prompt
    const evaluationContent = `SQL Query: ${sql}

Thought Process: ${thoughtProcess}

Results: ${JSON.stringify(results.slice(0, 10), null, 2)}${
      results.length > 10 ? `\n\n...and ${results.length - 10} more rows` : ""
    }`;

    // Get evaluations from all models
    const evaluations: EvaluationResult[] = [];

    for (const model of this.evaluationModels) {
      try {
        // Use the retry helper for the entire evaluation process
        const evaluationResult = await this.retryWithBackoff(
          async () => {
            // Send to evaluation model
            const messages: ChatMessage[] = [
              {
                role: "system",
                content: this.evaluationPrompt,
              },
              { role: "user", content: evaluationContent },
            ];
            const modelRouter = new ModelRouter(model);
            const responseText = await modelRouter.sendToModel(messages);

            // Parse the response using the helper function
            const parsedResult = this.parseModelResponse(
              responseText
            ) as EvaluationResult;
            parsedResult.model = model;

            if (typeof parsedResult.value !== "number") {
              throw new Error(
                'Evaluation result does not contain a numeric "value" field'
              );
            }

            return parsedResult;
          },
          3,
          `evaluation with model ${model}`
        );

        evaluations.push(evaluationResult);
      } catch (error) {
        console.error(
          `Failed to evaluate with model ${model} after all retries:`,
          error
        );
      }
    }

    // If no evaluations were successful, throw an error
    if (evaluations.length === 0) {
      throw new Error("All evaluation attempts failed for all models");
    }

    // Calculate average evaluation
    const totalValue = evaluations.reduce(
      (sum, evaluation) => sum + evaluation.value,
      0
    );
    const averageValue = totalValue / evaluations.length;

    // Combine explanations from all models
    const combinedExplanation = evaluations
      .map((evaluation) => `[${evaluation.model}]: ${evaluation.explanation}`)
      .join("\n\n");

    return {
      value: averageValue,
      explanation: combinedExplanation,
      model: this.evaluationModels[0],
    };
  }

  private async processQuestion(question: string): Promise<QuestionResult> {
    console.log(`\nProcessing question: "${question}"`);

    const result: QuestionResult = {
      question,
      sql: "",
      score: 0,
      explanation: "",
      resultCount: 0,
      executionTimeMs: 0,
      errorOccurred: false,
    };

    const startTime = Date.now();

    try {
      // Step 1: Send system prompt to generate SQL using Gemini Flash 2
      const messages: ChatMessage[] = [
        { role: "system", content: this.systemPrompt },
        {
          role: "user",
          content: `User Query: ${question} \n# KEEP THIS IN MIND:
When answering this question, you should pretend like you are a financial analyst. Your phone is right next to you, powered off.`,
        },
      ];
      const modelRouter = new ModelRouter(this.queryModel);
      const response = await modelRouter.sendToModel(messages);

      // Step 2: Extract SQL
      const queryResponse = this.extractSQL(response);

      if (!queryResponse.sql) {
        throw new Error("No SQL query found in the response");
      }

      result.sql = queryResponse.sql;
      console.log("Generated SQL:", queryResponse.sql);

      // Step 3: Execute SQL
      const queryStart = Date.now();
      const results = await this.executeQuery(queryResponse.sql);
      const queryEnd = Date.now();

      result.resultCount = results.length;
      result.executionTimeMs = queryEnd - queryStart;

      if (results.length === 0) {
        console.log("Warning: No results found for query");
      } else {
        console.log(`Query returned ${results.length} results`);
      }

      // Step 4: Evaluate results using Claude 3.7 Sonnet
      const evaluation = await this.evaluateResults(
        queryResponse.sql,
        queryResponse.content,
        results
      );

      result.score = evaluation.value;
      result.explanation = evaluation.explanation;

      console.log("Evaluation score:", evaluation.value);
      console.log("Evaluation explanation:", evaluation.explanation);
    } catch (error: any) {
      result.errorOccurred = true;
      result.errorMessage = error.message;
      result.score = 0; // Explicitly set score to 0 for failed queries
      console.error("Error processing question:", error.message);
    }

    const endTime = Date.now();
    console.log(`Processing time: ${endTime - startTime}ms`);

    return result;
  }

  private calculateStatistics(results: QuestionResult[]): AggregateStatistics {
    // Include all results in statistics, not just successful ones
    const scores = results.map((r) => r.score);
    const successfulResults = results.filter((r) => !r.errorOccurred);

    // Sort scores for median and other calculations
    const sortedScores = [...scores].sort((a, b) => a - b);

    // Calculate median
    const mid = Math.floor(sortedScores.length / 2);
    const median =
      sortedScores.length % 2 === 0
        ? (sortedScores[mid - 1] + sortedScores[mid]) / 2
        : sortedScores[mid];

    // Calculate average - include all results, including failed ones with score 0
    const sum = scores.reduce((acc, score) => acc + score, 0);
    const average = scores.length > 0 ? sum / scores.length : 0;

    // Calculate standard deviation
    const squaredDifferences = scores.map((score) =>
      Math.pow(score - average, 2)
    );
    const variance =
      squaredDifferences.reduce((acc, val) => acc + val, 0) / scores.length;
    const standardDeviation = Math.sqrt(variance);

    // Calculate score distribution
    const distribution = {
      "0.0-0.2": 0,
      "0.3-0.5": 0,
      "0.6-0.7": 0,
      "0.8-0.9": 0,
      "1.0": 0,
    };

    scores.forEach((score) => {
      if (score <= 0.2) distribution["0.0-0.2"]++;
      else if (score <= 0.5) distribution["0.3-0.5"]++;
      else if (score <= 0.7) distribution["0.6-0.7"]++;
      else if (score <= 0.9) distribution["0.8-0.9"]++;
      else distribution["1.0"]++;
    });

    // Convert to percentages
    Object.keys(distribution).forEach((key) => {
      distribution[key] =
        scores.length > 0 ? (distribution[key] / scores.length) * 100 : 0;
    });

    return {
      averageScore: average,
      medianScore: median,
      minScore: sortedScores[0] || 0,
      maxScore: sortedScores[sortedScores.length - 1] || 0,
      standardDeviation,
      executionSuccessRate: (successfulResults.length / results.length) * 100,
      averageExecutionTimeMs:
        successfulResults.length > 0
          ? successfulResults.reduce((acc, r) => acc + r.executionTimeMs, 0) /
            successfulResults.length
          : 0,
      scoreDistribution: distribution,
    };
  }

  private async exportResultsToCSV(
    results: QuestionResult[],
    outputPath: string
  ): Promise<void> {
    const csvWriter = createObjectCsvWriter({
      path: outputPath,
      header: [
        { id: "question", title: "Question" },
        { id: "score", title: "Score" },
        { id: "resultCount", title: "Result Count" },
        { id: "executionTimeMs", title: "Execution Time (ms)" },
        { id: "errorOccurred", title: "Error Occurred" },
        { id: "errorMessage", title: "Error Message" },
      ],
    });

    await csvWriter.writeRecords(results);
    console.log(`Results exported to ${outputPath}`);
  }

  public async runBatch(outputDir: string = "./output"): Promise<{
    results: QuestionResult[];
    statistics: AggregateStatistics;
  }> {
    // Create output directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Process each question sequentially
    for (const question of this.questions) {
      const result = await this.processQuestion(question);
      this.results.push(result);
    }

    // Calculate statistics
    const statistics = this.calculateStatistics(this.results);

    // Export results
    const timestamp = new Date().toISOString().replace(/:/g, "-");
    const modelInfo = `${this.queryModel}_${this.evaluationModels.join(
      "_"
    )}`.replace(/\//g, "_");
    const resultsPath = path.join(
      outputDir,
      `results_${modelInfo}_${timestamp}.csv`
    );
    const statsPath = path.join(
      outputDir,
      `statistics_${modelInfo}_${timestamp}.json`
    );

    await this.exportResultsToCSV(this.results, resultsPath);
    fs.writeFileSync(
      statsPath,
      JSON.stringify(
        {
          ...statistics,
          models: {
            queryModel: this.queryModel,
            evaluationModels: this.evaluationModels,
          },
          prompts: {
            systemPrompt: this.systemPrompt,
            evaluationPrompt: this.evaluationPrompt,
          },
        },
        null,
        2
      )
    );

    // Print summary
    console.log("\n========== EVALUATION SUMMARY ==========");
    console.log(`Query Model: ${this.queryModel}`);
    console.log(`Evaluation Models: ${this.evaluationModels.join(", ")}`);
    console.log("\nSystem Prompts:");
    console.log("Query System Prompt:");
    console.log(this.systemPrompt);
    console.log("\nEvaluation System Prompt:");
    console.log(this.evaluationPrompt);
    console.log("\nResults:");
    console.log(`Total questions: ${this.questions.length}`);
    console.log(
      `Successful queries: ${
        this.results.filter((r) => !r.errorOccurred).length
      }`
    );
    console.log(`Average score: ${statistics.averageScore.toFixed(2)}`);
    console.log(`Median score: ${statistics.medianScore.toFixed(2)}`);
    console.log(`Min score: ${statistics.minScore.toFixed(2)}`);
    console.log(`Max score: ${statistics.maxScore.toFixed(2)}`);
    console.log(
      `Standard deviation: ${statistics.standardDeviation.toFixed(2)}`
    );
    console.log(`Success rate: ${statistics.executionSuccessRate.toFixed(2)}%`);
    console.log(
      `Average execution time: ${statistics.averageExecutionTimeMs.toFixed(
        2
      )}ms`
    );
    console.log("\nScore distribution:");
    console.log(
      `  Poor (0.0-0.2): ${statistics.scoreDistribution["0.0-0.2"].toFixed(2)}%`
    );
    console.log(
      `  Fair (0.3-0.5): ${statistics.scoreDistribution["0.3-0.5"].toFixed(2)}%`
    );
    console.log(
      `  Good (0.6-0.7): ${statistics.scoreDistribution["0.6-0.7"].toFixed(2)}%`
    );
    console.log(
      `  Very Good (0.8-0.9): ${statistics.scoreDistribution["0.8-0.9"].toFixed(
        2
      )}%`
    );
    console.log(
      `  Excellent (1.0): ${statistics.scoreDistribution["1.0"].toFixed(2)}%`
    );
    console.log("==========================================");

    return {
      results: this.results,
      statistics,
    };
  }
}

// Example usage
async function main() {
  const apiKey = process.env.REQUESTY_API_KEY;
  if (!apiKey) {
    throw new Error("REQUESTY_API_KEY environment variable is not set");
  }

  // Define the models to test
  const queryModels = [
    RequestyAiModelEnum.gpt4o,
    RequestyAiModelEnum.gpt4OneNano,
    RequestyAiModelEnum.deepSeekV3,
    OpenRouterAiModelEnum.geminiFlash2,
    OpenRouterAiModelEnum.gemini25Pro,
    OpenRouterAiModelEnum.llama4Maverick,
    RequestyAiModelEnum.claude37Sonnet,
    OpenRouterAiModelEnum.claude37SonnetThinking,
    RequestyAiModelEnum.grok3Mini,
    RequestyAiModelEnum.grok3,
    RequestyAiModelEnum.gpt4One,
    RequestyAiModelEnum.gpt4OneNano,
    RequestyAiModelEnum.gpt4OneMini,
    RequestyAiModelEnum.o3Mini,
    RequestyAiModelEnum.o3,
    RequestyAiModelEnum.o4Mini,
    RequestyAiModelEnum.o4MiniLow,
    RequestyAiModelEnum.o4MiniHigh,
  ];

  // Define the evaluation models
  const evaluationModels = [
    RequestyAiModelEnum.claude37Sonnet,
    OpenRouterAiModelEnum.gemini25Pro,
    RequestyAiModelEnum.gpt4One,
  ];

  console.log("\n========== STARTING PARALLEL MODEL EVALUATION ==========");
  console.log(
    `Testing ${queryModels.length} query models with ${evaluationModels.length} evaluation models`
  );

  // Process all query models in parallel
  const evaluatorPromises = queryModels.map(async (queryModel) => {
    console.log(`\nStarting evaluation for model: ${queryModel}`);

    // Create and run the batch evaluator
    const evaluator = new BatchSQLEvaluator({
      systemPrompt,
      evaluationPrompt,
      queryModel,
      evaluationModels,
      questions,
    });

    try {
      const result = await evaluator.runBatch("./output");
      console.log(`Completed evaluation for model: ${queryModel}`);
      return { model: queryModel, result };
    } catch (error) {
      console.error(
        `Error running batch SQL evaluator for model ${queryModel}:`,
        error
      );
      return { model: queryModel, error };
    }
  });

  // Wait for all evaluations to complete
  const results = await Promise.all(evaluatorPromises);

  // Print summary of all results
  console.log("\n========== FINAL EVALUATION SUMMARY ==========");

  // Filter successful and failed evaluations
  const successfulResults = results.filter((r) => !r.error);
  const failedResults = results.filter((r) => r.error);

  console.log(
    `\nSuccessful evaluations: ${successfulResults.length}/${results.length}`
  );
  console.log(`Failed evaluations: ${failedResults.length}/${results.length}`);

  if (failedResults.length > 0) {
    console.log("\nFailed models:");
    failedResults.forEach(({ model, error }) => {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.log(`- ${model}: ${errorMessage}`);
    });
  }

  // Sort successful results by average score
  const sortedResults = [...successfulResults].sort(
    (a, b) =>
      b.result.statistics.averageScore - a.result.statistics.averageScore
  );

  console.log("\nModel Rankings (by average score):");
  sortedResults.forEach(({ model, result }, index) => {
    console.log(
      `${index + 1}. ${model}: ${result.statistics.averageScore.toFixed(3)}`
    );
  });

  console.log("\n========== EVALUATION COMPLETE ==========");
}

(async () => {
  await main();
  process.exit(0);
})();

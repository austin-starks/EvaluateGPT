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
  successRate: number;
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
  private evaluationModel: AiModelEnum;
  private bigquery: BigQuery;
  private questions: string[];
  private results: QuestionResult[] = [];

  constructor({
    systemPrompt,
    evaluationPrompt,
    queryModel,
    evaluationModel,
    questions,
  }: {
    systemPrompt: string;
    evaluationPrompt: string;
    queryModel: AiModelEnum;
    evaluationModel: AiModelEnum;
    questions: string[];
  }) {
    this.systemPrompt = systemPrompt;
    this.evaluationPrompt = evaluationPrompt;
    this.queryModel = queryModel;
    this.evaluationModel = evaluationModel;
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

    // Send to evaluation model using Requesty with Claude 3.7 Sonnet
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: this.evaluationPrompt,
      },
      { role: "user", content: evaluationContent },
    ];
    const modelRouter = new ModelRouter(this.evaluationModel);
    const responseText = await modelRouter.sendToModel(messages);

    try {
      // Try to extract JSON from the response
      const jsonMatch =
        responseText.match(/```json\n([\s\S]*?)\n```/) ||
        responseText.match(/{[\s\S]*?}/);

      let jsonText = jsonMatch ? jsonMatch[1] || jsonMatch[0] : responseText;

      // Clean up the JSON if necessary
      if (!jsonText.startsWith("{")) {
        jsonText = "{" + jsonText.split("{").slice(1).join("{");
      }

      const evaluationResult = JSON.parse(jsonText) as EvaluationResult;

      if (typeof evaluationResult.value !== "number") {
        throw new Error(
          'Evaluation result does not contain a numeric "value" field'
        );
      }

      return evaluationResult;
    } catch (error) {
      console.error("Error parsing evaluation result:", error);
      console.error("Raw response:", responseText);
      return { value: 0, explanation: "Failed to parse evaluation result" };
    }
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
      successRate: (successfulResults.length / results.length) * 100,
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
    const modelInfo = `${this.queryModel}_${this.evaluationModel}`.replace(
      /\//g,
      "_"
    );
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
            evaluationModel: this.evaluationModel,
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
    console.log(`Evaluation Model: ${this.evaluationModel}`);
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
    console.log(`Success rate: ${statistics.successRate.toFixed(2)}%`);
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
  // Create and run the batch evaluator
  const evaluator = new BatchSQLEvaluator({
    systemPrompt,
    evaluationPrompt,
    queryModel: OpenRouterAiModelEnum.optimusAlpha,
    evaluationModel: RequestyAiModelEnum.claude37Sonnet,
    questions,
  });

  try {
    await evaluator.runBatch("./output");
  } catch (error) {
    console.error("Error running batch SQL evaluator:", error);
  }
}

(async () => {
  await main();
  process.exit(0);
})();

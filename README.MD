# EvaluateGPT

This tool evaluates the effectiveness of AI system prompts for generating SQL queries against a financial database. It uses Requesty to leverage Gemini Flash 2 for generating SQL queries and Claude 3.7 Sonnet for evaluating those queries.

## Features

- Batch processing of multiple natural language questions
- Automated SQL generation using Gemini Flash 2
- SQL execution against BigQuery
- Comprehensive evaluation using Claude 3.7 Sonnet
- Detailed analytics and statistics on system prompt performance
- CSV and JSON output for further analysis

## Prerequisites

- Node.js 14+ and npm
- TypeScript
- BigQuery access
- [Requesty account](https://app.requesty.ai/join?ref=e0603ee5)

## Installation

1. Clone this repository
2. Install dependencies:

```bash
npm install
```

3. Install the following npm packages:

```bash
npm install axios dotenv @google-cloud/bigquery fs path csv-writer ts-node typescript @types/node
```

4. Configure environment variables in a `.env` file:

```
REQUESTY_API_KEY=your_requesty_api_key
GOOGLE_APPLICATION_CREDENTIALS_JSON={"type":"service_account","project_id":"..."}
```

## Configuration

The main configuration options are:

- `systemPrompt`: The prompt used to generate SQL queries
- `evaluationPrompt`: The prompt used to evaluate query quality
- `questions`: An array of natural language questions to test
- `queryModel`: The model to use for SQL generation (default: Gemini Flash 2)
- `evaluationModel`: The model to use for evaluation (default: Claude 3.7 Sonnet)

## Usage

Run the evaluation using ts-node:

```bash
npx ts-node main.ts
```

Alternatively, you can add a script to your `package.json`:

```json
{
  "scripts": {
    "start": "ts-node main.ts"
  }
}
```

Then run:

```bash
npm run start
```

The script will:

1. Process each question in the `questions` array
2. Generate SQL queries using Gemini Flash 2
3. Execute queries against BigQuery
4. Evaluate results using Claude 3.7 Sonnet
5. Generate detailed output files in the `./output` directory

## Output

The script generates:

1. A CSV file with detailed results for each question
2. A JSON file with aggregate statistics
3. Console output summarizing the results

The statistics include:

- Average, median, min, and max scores
- Standard deviation
- Success rate
- Score distribution
- Average execution time

## Example Output

```
========== EVALUATION SUMMARY ==========
Total questions: 20
Successful queries: 18
Average score: 0.76
Median score: 0.80
Min score: 0.40
Max score: 0.95
Standard deviation: 0.15
Success rate: 90.00%
Average execution time: 1253.45ms

Score distribution:
  Poor (0.0-0.2): 0.00%
  Fair (0.3-0.5): 16.67%
  Good (0.6-0.7): 27.78%
  Very Good (0.8-0.9): 50.00%
  Excellent (1.0): 5.56%
==========================================
```

## Why Use Requesty?

This tool uses [Requesty](https://app.requesty.ai/join?ref=e0603ee5) for AI model access, which provides:

- Simple access to multiple AI models including Gemini Flash 2 and Claude 3.7 Sonnet
- Consistent API interface across models
- Cost-effective pricing
- Advanced analytics and more.

## Database Schema

The default configuration assumes a financial database with tables for stock prices and financial data. Customize the `systemPrompt` to match your specific database schema.

## License

MIT

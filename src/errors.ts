import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export class AirtableApiError extends McpError {
  constructor(message: string, public statusCode?: number) {
    super(ErrorCode.InternalError, `Airtable API error: ${message}`);
    this.name = "AirtableApiError";
  }
}

export class RateLimitError extends AirtableApiError {
  constructor(public retryAfter?: number) {
    super("Rate limit exceeded", 429);
    this.name = "RateLimitError";
  }
}

export class ValidationError extends McpError {
  constructor(message: string) {
    super(ErrorCode.InvalidRequest, `Validation error: ${message}`);
    this.name = "ValidationError";
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(`Configuration error: ${message}`);
    this.name = "ConfigurationError";
  }
}

// Retry configuration
export interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2,
};

// Helper to determine if an error is retryable
export function isRetryableError(error: unknown): boolean {
  if (error instanceof RateLimitError) {
    return true;
  }
  
  if (error instanceof AirtableApiError) {
    // Retry on 5xx errors and specific 4xx errors
    return (
      error.statusCode !== undefined &&
      (error.statusCode >= 500 || error.statusCode === 429 || error.statusCode === 408)
    );
  }
  
  return false;
}

// Exponential backoff with jitter
export function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = Math.min(
    config.initialDelay * Math.pow(config.backoffMultiplier, attempt - 1),
    config.maxDelay
  );
  
  // Add jitter (±25%)
  const jitter = exponentialDelay * 0.25;
  return Math.floor(exponentialDelay + (Math.random() - 0.5) * 2 * jitter);
}
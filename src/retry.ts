import {
  RetryConfig,
  DEFAULT_RETRY_CONFIG,
  isRetryableError,
  calculateDelay,
  RateLimitError,
} from "./errors.js";

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const finalConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 1; attempt <= finalConfig.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if it's not a retryable error
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't retry if we've exhausted attempts
      if (attempt === finalConfig.maxRetries) {
        throw error;
      }

      // Calculate delay
      let delay = calculateDelay(attempt, finalConfig);

      // If it's a rate limit error with a retry-after header, use that
      if (error instanceof RateLimitError && error.retryAfter !== undefined) {
        delay = error.retryAfter * 1000; // Convert seconds to milliseconds
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}
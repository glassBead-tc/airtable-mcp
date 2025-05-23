export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Logger {
  private static instance: Logger;
  private level: LogLevel;

  private constructor() {
    const logLevel = process.env.LOG_LEVEL?.toUpperCase();
    this.level = LogLevel[logLevel as keyof typeof LogLevel] ?? LogLevel.INFO;
  }

  static getInstance(): Logger {
    if (Logger.instance === undefined) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level;
  }

  private formatMessage(level: string, message: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    const baseMessage = `[${timestamp}] [${level}] ${message}`;
    
    if (meta !== undefined) {
      return `${baseMessage} ${JSON.stringify(meta)}`;
    }
    
    return baseMessage;
  }

  debug(message: string, meta?: unknown): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.error(this.formatMessage("DEBUG", message, meta));
    }
  }

  info(message: string, meta?: unknown): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.error(this.formatMessage("INFO", message, meta));
    }
  }

  warn(message: string, meta?: unknown): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.error(this.formatMessage("WARN", message, meta));
    }
  }

  error(message: string, error?: unknown): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      const errorMeta = error instanceof Error 
        ? { message: error.message, stack: error.stack }
        : error;
      console.error(this.formatMessage("ERROR", message, errorMeta));
    }
  }
}
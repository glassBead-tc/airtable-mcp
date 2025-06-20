#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import fs from "node:fs/promises";
import path from "node:path";
import {
  FieldOption,
  fieldRequiresOptions,
  getDefaultOptions,
  FieldValue,
  AirtableBase,
  AirtableTable,
  AirtableRecord,
  AirtableError,
} from "./types.js";
import { AirtableApiError, RateLimitError } from "./errors.js";
import { withRetry } from "./retry.js";

const API_KEY = process.env.AIRTABLE_API_KEY;
if (API_KEY === undefined || API_KEY === "") {
  throw new Error("AIRTABLE_API_KEY environment variable is required");
}

class AirtableServer {
  private server: Server;
  private axiosInstance: AxiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: "airtable-server",
        version: "0.2.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: "https://api.airtable.com/v0",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
    });

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error: Error): void => console.error("[MCP Error]", error);
    process.on("SIGINT", () => {
      void this.server.close().then(() => {
        process.exit(0);
      });
    });
  }

  private async sendProgress(
    token: string | number | undefined,
    progress: number,
    total = 100,
    message?: string
  ): Promise<void> {
    if (token === undefined) {
      return;
    }
    await this.server.notification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total, message },
    });
  }

  private validateField(field: FieldOption): FieldOption {
    const { type } = field;

    // Remove options for fields that don't need them
    if (!fieldRequiresOptions(type)) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { options, ...rest } = field;
      return rest;
    }

    // Add default options for fields that require them
    if (!field.options) {
      return {
        ...field,
        options: getDefaultOptions(type),
      };
    }

    return field;
  }

  private setupToolHandlers(): void {
    // Resource handlers for MCP 2025-06-18
    this.server.setRequestHandler(ListResourcesRequestSchema, () => {
      return {
        resources: [
          {
            uri: "file://prompts/system-prompt.md",
            name: "System Prompt",
            description: "System prompt for the Airtable server",
            mimeType: "text/markdown",
          },
          {
            uri: "file://prompts/project-knowledge.md",
            name: "Project Knowledge",
            description: "Project-specific knowledge",
            mimeType: "text/markdown",
          },
        ],
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      if (!uri.startsWith("file://")) {
        throw new McpError(ErrorCode.InvalidRequest, "Unsupported URI");
      }
      const relPath = uri.replace("file://", "");
      const filePath = path.join(process.cwd(), relPath);
      const data = await fs.readFile(filePath, "utf8");
      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: data,
          },
        ],
      };
    });

    // Register available tools
    this.server.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({
        tools: [
          {
            name: "list_bases",
            description: "List all accessible Airtable bases",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
          {
            name: "list_tables",
            description: "List all tables in a base",
            inputSchema: {
              type: "object",
              properties: {
                base_id: {
                  type: "string",
                  description: "ID of the base",
                },
              },
              required: ["base_id"],
            },
          },
          {
            name: "create_table",
            description: "Create a new table in a base",
            inputSchema: {
              type: "object",
              properties: {
                base_id: {
                  type: "string",
                  description: "ID of the base",
                },
                table_name: {
                  type: "string",
                  description: "Name of the new table",
                },
                description: {
                  type: "string",
                  description: "Description of the table",
                },
                fields: {
                  type: "array",
                  description: "Initial fields for the table",
                  items: {
                    type: "object",
                    properties: {
                      name: {
                        type: "string",
                        description: "Name of the field",
                      },
                      type: {
                        type: "string",
                        description:
                          "Type of the field (e.g., singleLineText, multilineText, number, etc.)",
                      },
                      description: {
                        type: "string",
                        description: "Description of the field",
                      },
                      options: {
                        type: "object",
                        description: "Field-specific options",
                      },
                    },
                    required: ["name", "type"],
                  },
                },
              },
              required: ["base_id", "table_name"],
            },
          },
          {
            name: "update_table",
            description: "Update a table's schema",
            inputSchema: {
              type: "object",
              properties: {
                base_id: {
                  type: "string",
                  description: "ID of the base",
                },
                table_id: {
                  type: "string",
                  description: "ID of the table to update",
                },
                name: {
                  type: "string",
                  description: "New name for the table",
                },
                description: {
                  type: "string",
                  description: "New description for the table",
                },
              },
              required: ["base_id", "table_id"],
            },
          },
          {
            name: "create_field",
            description: "Create a new field in a table",
            inputSchema: {
              type: "object",
              properties: {
                base_id: {
                  type: "string",
                  description: "ID of the base",
                },
                table_id: {
                  type: "string",
                  description: "ID of the table",
                },
                field: {
                  type: "object",
                  properties: {
                    name: {
                      type: "string",
                      description: "Name of the field",
                    },
                    type: {
                      type: "string",
                      description: "Type of the field",
                    },
                    description: {
                      type: "string",
                      description: "Description of the field",
                    },
                    options: {
                      type: "object",
                      description: "Field-specific options",
                    },
                  },
                  required: ["name", "type"],
                },
              },
              required: ["base_id", "table_id", "field"],
            },
          },
          {
            name: "update_field",
            description: "Update a field in a table",
            inputSchema: {
              type: "object",
              properties: {
                base_id: {
                  type: "string",
                  description: "ID of the base",
                },
                table_id: {
                  type: "string",
                  description: "ID of the table",
                },
                field_id: {
                  type: "string",
                  description: "ID of the field to update",
                },
                updates: {
                  type: "object",
                  properties: {
                    name: {
                      type: "string",
                      description: "New name for the field",
                    },
                    description: {
                      type: "string",
                      description: "New description for the field",
                    },
                    options: {
                      type: "object",
                      description: "New field-specific options",
                    },
                  },
                },
              },
              required: ["base_id", "table_id", "field_id", "updates"],
            },
          },
          {
            name: "list_records",
            description: "List records in a table",
            inputSchema: {
              type: "object",
              properties: {
                base_id: {
                  type: "string",
                  description: "ID of the base",
                },
                table_name: {
                  type: "string",
                  description: "Name of the table",
                },
                max_records: {
                  type: "number",
                  description: "Maximum number of records to return",
                },
              },
              required: ["base_id", "table_name"],
            },
          },
          {
            name: "create_record",
            description: "Create a new record in a table",
            inputSchema: {
              type: "object",
              properties: {
                base_id: {
                  type: "string",
                  description: "ID of the base",
                },
                table_name: {
                  type: "string",
                  description: "Name of the table",
                },
                fields: {
                  type: "object",
                  description: "Record fields as key-value pairs",
                },
              },
              required: ["base_id", "table_name", "fields"],
            },
          },
          {
            name: "update_record",
            description: "Update an existing record in a table",
            inputSchema: {
              type: "object",
              properties: {
                base_id: {
                  type: "string",
                  description: "ID of the base",
                },
                table_name: {
                  type: "string",
                  description: "Name of the table",
                },
                record_id: {
                  type: "string",
                  description: "ID of the record to update",
                },
                fields: {
                  type: "object",
                  description: "Record fields to update as key-value pairs",
                },
              },
              required: ["base_id", "table_name", "record_id", "fields"],
            },
          },
          {
            name: "delete_record",
            description: "Delete a record from a table",
            inputSchema: {
              type: "object",
              properties: {
                base_id: {
                  type: "string",
                  description: "ID of the base",
                },
                table_name: {
                  type: "string",
                  description: "Name of the table",
                },
                record_id: {
                  type: "string",
                  description: "ID of the record to delete",
                },
              },
              required: ["base_id", "table_name", "record_id"],
            },
          },
          {
            name: "search_records",
            description: "Search for records in a table",
            inputSchema: {
              type: "object",
              properties: {
                base_id: {
                  type: "string",
                  description: "ID of the base",
                },
                table_name: {
                  type: "string",
                  description: "Name of the table",
                },
                field_name: {
                  type: "string",
                  description: "Name of the field to search in",
                },
                value: {
                  type: "string",
                  description: "Value to search for",
                },
              },
              required: ["base_id", "table_name", "field_name", "value"],
            },
          },
          {
            name: "get_record",
            description: "Get a single record by its ID",
            inputSchema: {
              type: "object",
              properties: {
                base_id: {
                  type: "string",
                  description: "ID of the base",
                },
                table_name: {
                  type: "string",
                  description: "Name of the table",
                },
                record_id: {
                  type: "string",
                  description: "ID of the record to retrieve",
                },
              },
              required: ["base_id", "table_name", "record_id"],
            },
          },
        ],
      })
    );

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case "list_bases": {
            const response = await withRetry(() =>
              this.axiosInstance.get<{ bases: AirtableBase[] }>("/meta/bases")
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data.bases, null, 2),
                },
              ],
            };
          }

          case "list_tables": {
            const { base_id } = request.params.arguments as { base_id: string };
            const response = await this.axiosInstance.get<{ tables: AirtableTable[] }>(
              `/meta/bases/${base_id}/tables`
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data.tables, null, 2),
                },
              ],
            };
          }

          case "create_table": {
            const progressToken = request.params._meta?.progressToken;
            await this.sendProgress(progressToken, 0, 100, "Creating table");

            const { base_id, table_name, description, fields } = request.params.arguments as {
              base_id: string;
              table_name: string;
              description?: string;
              fields?: FieldOption[];
            };

            // Validate and prepare fields
            const validatedFields = fields?.map((field) => this.validateField(field));

            const response = await this.axiosInstance.post(`/meta/bases/${base_id}/tables`, {
              name: table_name,
              description,
              fields: validatedFields,
            });

            await this.sendProgress(progressToken, 100, 100, "Table created");

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          }

          case "update_table": {
            const { base_id, table_id, name, description } = request.params.arguments as {
              base_id: string;
              table_id: string;
              name?: string;
              description?: string;
            };

            const response = await this.axiosInstance.patch(
              `/meta/bases/${base_id}/tables/${table_id}`,
              {
                name,
                description,
              }
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          }

          case "create_field": {
            const { base_id, table_id, field } = request.params.arguments as {
              base_id: string;
              table_id: string;
              field: FieldOption;
            };

            // Validate field before creation
            const validatedField = this.validateField(field);

            const response = await this.axiosInstance.post(
              `/meta/bases/${base_id}/tables/${table_id}/fields`,
              validatedField
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          }

          case "update_field": {
            const { base_id, table_id, field_id, updates } = request.params.arguments as {
              base_id: string;
              table_id: string;
              field_id: string;
              updates: Partial<FieldOption>;
            };

            const response = await this.axiosInstance.patch(
              `/meta/bases/${base_id}/tables/${table_id}/fields/${field_id}`,
              updates
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          }

          case "list_records": {
            const { base_id, table_name, max_records } = request.params.arguments as {
              base_id: string;
              table_name: string;
              max_records?: number;
            };
            const response = await this.axiosInstance.get<{ records: AirtableRecord[] }>(
              `/${base_id}/${table_name}`,
              {
                params:
                  max_records !== undefined && max_records > 0
                    ? { maxRecords: max_records }
                    : undefined,
              }
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data.records, null, 2),
                },
              ],
            };
          }

          case "create_record": {
            const progressToken = request.params._meta?.progressToken;
            await this.sendProgress(progressToken, 0, 100, "Creating record");

            const { base_id, table_name, fields } = request.params.arguments as {
              base_id: string;
              table_name: string;
              fields: Record<string, FieldValue>;
            };
            const response = await this.axiosInstance.post(`/${base_id}/${table_name}`, {
              fields,
            });

            await this.sendProgress(progressToken, 100, 100, "Record created");
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          }

          case "update_record": {
            const progressToken = request.params._meta?.progressToken;
            await this.sendProgress(progressToken, 0, 100, "Updating record");

            const { base_id, table_name, record_id, fields } = request.params.arguments as {
              base_id: string;
              table_name: string;
              record_id: string;
              fields: Record<string, FieldValue>;
            };
            const response = await this.axiosInstance.patch(
              `/${base_id}/${table_name}/${record_id}`,
              { fields }
            );
            await this.sendProgress(progressToken, 100, 100, "Record updated");
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          }

          case "delete_record": {
            const { base_id, table_name, record_id } = request.params.arguments as {
              base_id: string;
              table_name: string;
              record_id: string;
            };
            const response = await this.axiosInstance.delete(
              `/${base_id}/${table_name}/${record_id}`
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          }

          case "search_records": {
            const { base_id, table_name, field_name, value } = request.params.arguments as {
              base_id: string;
              table_name: string;
              field_name: string;
              value: string;
            };
            const response = await this.axiosInstance.get<{ records: AirtableRecord[] }>(
              `/${base_id}/${table_name}`,
              {
                params: {
                  filterByFormula: `{${field_name}} = "${value}"`,
                },
              }
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data.records, null, 2),
                },
              ],
            };
          }

          case "get_record": {
            const { base_id, table_name, record_id } = request.params.arguments as {
              base_id: string;
              table_name: string;
              record_id: string;
            };
            const response = await this.axiosInstance.get(`/${base_id}/${table_name}/${record_id}`);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const airtableError = error.response?.data as AirtableError | undefined;
          const statusCode = error.response?.status;

          // Handle rate limiting
          if (statusCode === 429) {
            const retryAfter = error.response?.headers["retry-after"] as string | undefined;
            throw new RateLimitError(
              retryAfter !== undefined ? parseInt(retryAfter, 10) : undefined
            );
          }

          // Handle other API errors
          throw new AirtableApiError(airtableError?.error?.message ?? error.message, statusCode);
        }
        throw error;
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Airtable MCP server running on stdio");
  }
}

const server = new AirtableServer();
server.run().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

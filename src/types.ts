export interface ServerParameters {
  command: string;
  args?: string[];
  allowedDirectory?: string;
  env?: Record<string, string>;
}

export interface LLMConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface BridgeConfig {
  mcpServer: ServerParameters;
  mcpServerName: string;
  llmConfig: LLMConfig;
  systemPrompt?: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}
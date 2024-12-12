import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { logger } from './logger';

export interface MCPServerConfig {
  command: string;
  args: string[];
  allowedDirectory?: string;
  env?: Record<string, string>;
}

export interface BridgeConfigFile {
  mcpServers: {
    [key: string]: MCPServerConfig;
  };
  llm?: {
    model: string;
    baseUrl: string;
    apiKey?: string;
    temperature?: number;
    maxTokens?: number;
  };
  systemPrompt?: string;
}

function interpolateEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\${([^}]+)}/g, (_, envVar) => {
      const value = process.env[envVar];
      if (!value) {
        logger.warn(`Environment variable ${envVar} not found`);
        return `\${${envVar}}`;  // Keep the original placeholder if not found
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(item => interpolateEnvVars(item));
  }

  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value);
    }
    return result;
  }

  return obj;
}

export async function loadBridgeConfig(): Promise<BridgeConfigFile> {
  const DEFAULT_CONFIG: BridgeConfigFile = {
    mcpServers: {
      filesystem: {
        command: process.platform === 'win32' 
          ? 'C:\\Program Files\\nodejs\\node.exe'
          : 'node',
        args: [
          path.join(process.env.HOME || '', 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js'),
          path.join(process.env.HOME || '', 'bridgeworkspace')
        ],
        allowedDirectory: path.join(process.env.HOME || '', 'bridgeworkspace')
      }
    },
    llm: {
      model: "qwen2.5-coder:7b-instruct",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
      temperature: 0.7,
      maxTokens: 1000
    },
    systemPrompt: "You are a helpful assistant that can use tools to help answer questions."
  };
  
  try {
    // First load environment variables
    dotenv.config();
    
    // Then load and parse the config file
    const configPath = path.join(process.cwd(), 'bridge_config.json');
    const configData = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configData) as BridgeConfigFile;
    
    logger.info(`Loaded bridge configuration from ${configPath}`);
    
    // Interpolate environment variables in the config
    const processedConfig = interpolateEnvVars(config);

    // Merge with defaults
    const mergedConfig = {
      ...DEFAULT_CONFIG,
      ...processedConfig,
      mcpServers: {
        ...DEFAULT_CONFIG.mcpServers,
        ...processedConfig.mcpServers
      },
      llm: {
        ...DEFAULT_CONFIG.llm,
        ...processedConfig.llm
      }
    } as BridgeConfigFile;

    // Validate that required env vars are set
    Object.entries(mergedConfig.mcpServers).forEach(([name, server]) => {
      if (server.env) {
        Object.entries(server.env).forEach(([key, value]) => {
          if (typeof value === 'string' && value.includes('${')) {
            logger.warn(`MCP '${name}' is missing required environment variable: ${key}`);
          }
        });
      }
    });

    return mergedConfig;
  } catch (error: any) {
    logger.warn(`Could not load bridge_config.json: ${error?.message || String(error)}`);
    logger.warn('Using default configuration');
    return DEFAULT_CONFIG;
  }
}
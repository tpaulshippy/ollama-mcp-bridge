import { loadBridgeConfig } from './config';
import { BridgeConfig } from './types';
import { MCPLLMBridge } from './bridge';
import { logger } from './logger';
import readline from 'readline';
import dotenv from 'dotenv';
import path from 'path';

// Configure readline for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  try {
    // Load environment variables
    dotenv.config();

    // Load bridge configuration
    const configFile = await loadBridgeConfig();

    // Select which MCP server to use
    const mcpServerName = process.env.MCP_SERVER || 'filesystem';
    const mcpServer = configFile.mcpServers[mcpServerName];

    if (!mcpServer) {
      throw new Error(`MCP server "${mcpServerName}" not found in configuration`);
    }

    // Create bridge configuration
    const config: BridgeConfig = {
      mcpServer,
      mcpServerName,
      llmConfig: configFile.llm!,
      systemPrompt: configFile.systemPrompt
    };

    logger.info(`Starting bridge with model: ${config.llmConfig.model}`);
    logger.info(`Using MCP server: ${mcpServerName}`);
    logger.info(`Allowed directory: ${mcpServer.allowedDirectory || 'Not specified'}`);

    // Initialize bridge
    const bridge = new MCPLLMBridge(config);
    const initialized = await bridge.initialize();
    
    if (!initialized) {
      throw new Error('Failed to initialize the bridge');
    }

    logger.info('Bridge initialized successfully');

    // Main interaction loop
    while (true) {
      try {
        const userInput = await question("\nEnter your prompt (or 'quit' to exit): ");
        
        if (['quit', 'exit', 'q'].includes(userInput.toLowerCase())) {
          break;
        }

        logger.info('Processing user input...');
        const response = await bridge.processMessage(userInput);
        logger.info('Received response from bridge');
        console.log(`\nResponse: ${response}`);
      } catch (error: any) {
        logger.error(`Error occurred: ${error?.message || String(error)}`);
      }
    }

    // Cleanup
    await bridge.close();
    rl.close();
    
  } catch (error: any) {
    logger.error(`Fatal error: ${error?.message || String(error)}`);
    process.exit(1);
  }
}

// Handle cleanup on process termination
process.on('SIGINT', () => {
  logger.info('\nExiting...');
  rl.close();
  process.exit(0);
});

// Only run if this is the main module
if (require.main === module) {
  main().catch((error: any) => {
    logger.error(`Unhandled error: ${error?.message || String(error)}`);
    process.exit(1);
  });
}

export { main };
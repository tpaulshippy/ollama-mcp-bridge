import readline from 'readline';
import { MCPLLMBridge } from './bridge';
import { loadBridgeConfig } from './config';
import { logger } from './logger';
import { BridgeConfig } from './types';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function forceExit() {
  logger.info('Force exiting...');
  
  try {
    const { exec } = require('child_process');
    exec('taskkill /F /IM ollama.exe', () => {});
    exec('netstat -ano | findstr ":11434"', (error: any, stdout: string) => {
      if (!error && stdout) {
        const pids = stdout.split('\n')
          .map(line => line.trim().split(/\s+/).pop())
          .filter(pid => pid && /^\d+$/.test(pid));
        
        pids.forEach(pid => {
          exec(`taskkill /F /PID ${pid}`, () => {});
        });
      }
    });
  } catch (e) {
    // Ignore errors during force kill
  }

  setTimeout(() => process.exit(0), 1000);
}

async function main() {
  try {
    logger.info('Starting main.ts...');
    const configFile = await loadBridgeConfig();

    const bridges = new Map<string, MCPLLMBridge>();
    const allTools: any[] = [];
    
    for (const [mcpServerName, mcpServer] of Object.entries(configFile.mcpServers)) {
      const config: BridgeConfig = {
        mcpServer,
        mcpServerName,
        llmConfig: configFile.llm!,
        systemPrompt: configFile.systemPrompt
      };

      logger.info(`Starting bridge with model: ${config.llmConfig.model}`);
      logger.info(`Using MCP server: ${mcpServerName}`);
      logger.info(`Allowed directory: ${mcpServer.allowedDirectory || 'Not specified'}`);

      const bridge = new MCPLLMBridge(config);
      const initialized = await bridge.initialize();
      
      if (!initialized) {
        logger.error(`Failed to initialize bridge for ${mcpServerName}`);
        continue;
      }

      bridges.set(mcpServerName, bridge);
      if (bridge.tools) {
        allTools.push(...bridge.tools);
      }
      logger.info(`Bridge initialized successfully for ${mcpServerName}`);
    }

    if (bridges.size === 0) {
      throw new Error('No bridges were successfully initialized');
    }

    logger.info('Available commands:');
    logger.info('  list-tools: Show all available tools and their parameters');
    logger.info('  quit: Exit the program');
    logger.info('  Any other input will be sent to the LLM');

    let isClosing = false;
    const primaryBridge = Array.from(bridges.values())[0];
    await primaryBridge.setTools(allTools);
    logger.info(`Total tools available: ${allTools.length}`);

    while (!isClosing) {
      try {
        const userInput = await question("\nEnter your prompt (or 'list-tools' or 'quit'): ");
        
        if (userInput.toLowerCase() === 'quit') {
          isClosing = true;
          for (const bridge of bridges.values()) {
            try {
              await bridge.close();
            } catch (e) {
              logger.error('Error closing bridge:', e);
            }
          }
          rl.close();
          forceExit();
          break;
        }

        if (userInput.toLowerCase() === 'list-tools') {
          await primaryBridge.llmClient.listTools();
          continue;
        }

        logger.info('Processing user input...');
        const response = await primaryBridge.processMessage(userInput);
        logger.info('Received response from bridge');
        console.log(`\nResponse: ${response}`);
      } catch (error: any) {
        logger.error(`Error occurred: ${error?.message || String(error)}`);
      }
    }
  } catch (error: any) {
    logger.error(`Fatal error: ${error?.message || String(error)}`);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  logger.info('Received SIGINT...');
  forceExit();
});

process.on('exit', () => {
  logger.info('Exiting process...');
});

if (require.main === module) {
  main().catch(error => {
    logger.error(`Unhandled error: ${error?.message || String(error)}`);
    forceExit();
  });
}

export { main };
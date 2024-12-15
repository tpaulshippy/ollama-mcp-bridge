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

// Map to track which MCP owns which tools
const toolToMCP = new Map<string, MCPLLMBridge>();

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
      
      // Map each tool to its MCP
      if (bridge.tools) {
        for (const tool of bridge.tools) {
          const toolName = tool.function.name;
          toolToMCP.set(toolName, bridge);
          logger.debug(`Mapped tool '${toolName}' to MCP '${mcpServerName}'`);
        }
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
    
    // All bridges get the full tool list so they know what's available
    for (const bridge of bridges.values()) {
      await bridge.setTools(allTools);
    }
    
    const primaryBridge = bridges.get('gmail-drive') || Array.from(bridges.values())[0];
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
        
        // Detect which tool might be needed and route to appropriate bridge
        const toolName = detectToolFromPrompt(userInput);
        const selectedBridge = toolName ? toolToMCP.get(toolName) || primaryBridge : primaryBridge;
        logger.info(`Using bridge for tool: ${toolName || 'default'}`);
        
        const response = await selectedBridge.processMessage(userInput);
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

// Helper function to detect which tool might be needed
function detectToolFromPrompt(prompt: string): string | null {
  const emailKeywords = ['email', 'send', 'mail', 'message'];
  const driveKeywords = ['drive', 'folder', 'file', 'upload'];
  const searchKeywords = ['find', 'search', 'locate', 'list'];

  prompt = prompt.toLowerCase();

  if (emailKeywords.some(keyword => prompt.includes(keyword)) && 
      prompt.includes('@')) {
    return 'send_email';
  }

  if (searchKeywords.some(keyword => prompt.includes(keyword))) {
    if (emailKeywords.some(keyword => prompt.includes(keyword))) {
      return 'search_email';
    }
    if (driveKeywords.some(keyword => prompt.includes(keyword))) {
      return 'search_drive';
    }
  }

  if (driveKeywords.some(keyword => prompt.includes(keyword))) {
    if (prompt.includes('folder') || prompt.includes('directory')) {
      return 'create_folder';
    }
    if (prompt.includes('upload') || prompt.includes('create file')) {
      return 'upload_file';
    }
    return 'search_drive';
  }

  return null;
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
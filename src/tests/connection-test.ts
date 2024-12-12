import { LLMClient } from '../llm-client';
import { LLMConfig } from '../types';
import { logger } from '../logger';

export async function testOllamaConnection(config: LLMConfig): Promise<boolean> {
  logger.info('Starting Ollama connection test...');
  
  const testClient = new LLMClient(config);
  const testPrompt = 'Respond with exactly the word "connected" if you can read this message.';
  
  try {
    logger.info('Testing basic connectivity to Ollama...');
    logger.info(`Attempting to connect to ${config.baseUrl} with model ${config.model}`);
    
    const response = await testClient.invokeWithPrompt(testPrompt);
    
    if (!response || !response.content) {
      logger.error('No response received from Ollama');
      return false;
    }

    const responseText = response.content.toLowerCase().trim();
    if (!responseText.includes('connected')) {
      logger.error(`Unexpected response from Ollama: "${response.content}"`);
      return false;
    }

    logger.info('Connection test completed successfully');
    logger.info(`Using model: ${config.model}`);
    logger.info(`Base URL: ${config.baseUrl}`);
    return true;

  } catch (error: any) {
    logger.error('Connection test failed with error');
    if (error?.message) {
      logger.error(`Error details: ${error.message}`);
    } else {
      logger.error(`Error details: ${String(error)}`);
    }
    return false;
  }
}

// Standalone test script
if (require.main === module) {
  const testConfig: LLMConfig = {
    model: "qwen2.5-coder:7b-instruct",  // Updated with exact model name
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    temperature: 0.7,
    maxTokens: 1000
  };

  testOllamaConnection(testConfig).then((success) => {
    if (success) {
      logger.info('✅ Successfully connected to Ollama');
      process.exit(0);
    } else {
      logger.error('❌ Failed to establish proper connection with Ollama');
      process.exit(1);
    }
  }).catch((error: any) => {
    logger.error('❌ Test runner encountered an error');
    if (error?.message) {
      logger.error(`Error details: ${error.message}`);
    }
    process.exit(1);
  });
}
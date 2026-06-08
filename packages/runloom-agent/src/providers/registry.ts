import { selectModel } from "../config/runloom-config.js";
import { ProviderError } from "../errors.js";
import { AnthropicMessagesProvider } from "./anthropic-messages-provider.js";
import { GoogleGeminiProvider } from "./google-gemini-provider.js";
import { OpenAIChatCompletionsProvider } from "./openai-chat-completions-provider.js";
import { OpenAIResponsesProvider } from "./openai-responses-provider.js";
import type {
  BuiltInProviderName,
  ModelProvider,
  ModelSelectionResult,
  RunloomConfig
} from "../types.js";

const PROVIDER_ALIASES: Record<string, string> = {
  openai: "openai-responses",
  "openai-chat": "openai-chat-completions",
  chat: "openai-chat-completions",
  anthropic: "anthropic-messages",
  claude: "anthropic-messages",
  google: "google-gemini",
  gemini: "google-gemini"
};

export interface ModelProviderRegistryOptions {
  provider?: BuiltInProviderName | ModelProvider;
  apiKey?: string;
  baseUrl?: string;
  config: RunloomConfig;
  workspace: string;
}

export interface ModelSelectionInput {
  text: string;
  model?: string;
  profile?: string;
  taskType?: string;
  language?: string;
}

export class ModelProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(private readonly options: ModelProviderRegistryOptions) {
    this.registerInitialProvider(options);
  }

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): ModelProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new ProviderError(`Model provider is not registered: ${providerId}`, {
        code: "provider.not_registered",
        details: { providerId }
      });
    }
    return provider;
  }

  select(input: ModelSelectionInput): ModelSelectionResult {
    return selectModel(this.options.config, {
      explicitModel: input.model,
      profile: input.profile,
      taskType: input.taskType,
      language: input.language,
      text: input.text,
      workspace: this.options.workspace,
      defaultProviderId: this.getActive().id,
      providerAliases: PROVIDER_ALIASES
    });
  }

  private getActive(): ModelProvider {
    const provider = this.providers.values().next().value as ModelProvider | undefined;
    if (!provider) {
      throw new ProviderError("No model provider is registered.", {
        code: "provider.not_registered"
      });
    }
    return provider;
  }

  private registerInitialProvider(options: ModelProviderRegistryOptions): void {
    if (!options.provider || options.provider === "openai-responses") {
      this.register(
        new OpenAIResponsesProvider({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl
        })
      );
      return;
    }
    if (options.provider === "openai-chat-completions") {
      this.register(
        new OpenAIChatCompletionsProvider({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl
        })
      );
      return;
    }
    if (options.provider === "anthropic-messages") {
      this.register(
        new AnthropicMessagesProvider({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl
        })
      );
      return;
    }
    if (options.provider === "google-gemini") {
      this.register(
        new GoogleGeminiProvider({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl
        })
      );
      return;
    }
    this.register(options.provider);
  }
}

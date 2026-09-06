// 由 scripts/update-models.ts 从 models.dev 生成(2026-09-06),不要手改;pnpm models:update 重取。
import type { Registry } from "./registry.js";

export const SNAPSHOT_DATE = "2026-09-06";

export const SNAPSHOT: Registry = {
  deepseek: {
    id: "deepseek",
    api: "https://api.deepseek.com",
    env: ["DEEPSEEK_API_KEY"],
    models: {
      "deepseek-v4-flash-vision-exp": {
        id: "deepseek-v4-flash-vision-exp",
        name: "DeepSeek V4 Flash Vision Exp",
        reasoning: true,
        reasoning_options: [
          {
            type: "toggle",
          },
          {
            type: "effort",
            values: ["low", "high", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 384000,
        },
        cost: {
          input: 0.14,
          output: 0.28,
          cache_read: 0.0028,
        },
      },
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        reasoning_options: [
          {
            type: "toggle",
          },
          {
            type: "effort",
            values: ["low", "high", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 384000,
        },
        cost: {
          input: 0.14,
          output: 0.28,
          cache_read: 0.0028,
        },
      },
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        reasoning_options: [
          {
            type: "toggle",
          },
          {
            type: "effort",
            values: ["high", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 384000,
        },
        cost: {
          input: 0.435,
          output: 0.87,
          cache_read: 0.003625,
        },
      },
    },
  },
  openai: {
    id: "openai",
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-5-nano": {
        id: "gpt-5-nano",
        name: "GPT-5 Nano",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["minimal", "low", "medium", "high"],
          },
        ],
        tool_call: true,
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        cost: {
          input: 0.05,
          output: 0.4,
          cache_read: 0.005,
        },
      },
      "gpt-4.1-nano": {
        id: "gpt-4.1-nano",
        name: "GPT-4.1 nano",
        reasoning: false,
        tool_call: true,
        limit: {
          context: 1047576,
          output: 32768,
        },
        cost: {
          input: 0.1,
          output: 0.4,
          cache_read: 0.025,
        },
      },
      "gpt-4o-2024-05-13": {
        id: "gpt-4o-2024-05-13",
        name: "GPT-4o (2024-05-13)",
        reasoning: false,
        tool_call: true,
        limit: {
          context: 128000,
          output: 4096,
        },
        cost: {
          input: 5,
          output: 15,
        },
      },
      "gpt-5-pro": {
        id: "gpt-5-pro",
        name: "GPT-5 Pro",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["high"],
          },
        ],
        tool_call: true,
        limit: {
          context: 400000,
          input: 272000,
          output: 272000,
        },
        cost: {
          input: 15,
          output: 120,
        },
      },
      "chatgpt-image-latest": {
        id: "chatgpt-image-latest",
        name: "chatgpt-image-latest",
        reasoning: false,
        tool_call: false,
        limit: {
          context: 0,
          input: 0,
          output: 0,
        },
      },
      "gpt-5.6-sol": {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high", "xhigh", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        cost: {
          input: 4,
          output: 20,
          cache_read: 0.4,
          cache_write: 5,
        },
      },
      "gpt-4o-2024-08-06": {
        id: "gpt-4o-2024-08-06",
        name: "GPT-4o (2024-08-06)",
        reasoning: false,
        tool_call: true,
        limit: {
          context: 128000,
          output: 16384,
        },
        cost: {
          input: 2.5,
          output: 10,
          cache_read: 1.25,
        },
      },
      "gpt-6-astra": {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        cost: {
          input: 10,
          output: 50,
          cache_read: 1,
          cache_write: 12.5,
        },
      },
      "gpt-5.2-pro": {
        id: "gpt-5.2-pro",
        name: "GPT-5.2 Pro",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["medium", "high", "xhigh"],
          },
        ],
        tool_call: true,
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        cost: {
          input: 21,
          output: 168,
        },
      },
      "gpt-5.3-codex-spark": {
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high", "xhigh"],
          },
        ],
        tool_call: true,
        limit: {
          context: 128000,
          input: 100000,
          output: 32000,
        },
        cost: {
          input: 1.75,
          output: 14,
          cache_read: 0.175,
        },
      },
      "gpt-4.1-mini": {
        id: "gpt-4.1-mini",
        name: "GPT-4.1 mini",
        reasoning: false,
        tool_call: true,
        limit: {
          context: 1047576,
          output: 32768,
        },
        cost: {
          input: 0.4,
          output: 1.6,
          cache_read: 0.1,
        },
      },
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high", "xhigh"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
        },
      },
      "gpt-4-turbo": {
        id: "gpt-4-turbo",
        name: "GPT-4 Turbo",
        reasoning: false,
        tool_call: true,
        limit: {
          context: 128000,
          output: 4096,
        },
        cost: {
          input: 10,
          output: 30,
        },
      },
      "gpt-5.1": {
        id: "gpt-5.1",
        name: "GPT-5.1",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high"],
          },
        ],
        tool_call: true,
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        cost: {
          input: 1.25,
          output: 10,
          cache_read: 0.125,
        },
      },
      o1: {
        id: "o1",
        name: "o1",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high"],
          },
        ],
        tool_call: true,
        limit: {
          context: 200000,
          output: 100000,
        },
        cost: {
          input: 15,
          output: 60,
          cache_read: 7.5,
        },
      },
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: false,
        tool_call: true,
        limit: {
          context: 128000,
          output: 16384,
        },
        cost: {
          input: 2.5,
          output: 10,
          cache_read: 1.25,
        },
      },
      "gpt-5.6-luna": {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high", "xhigh", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        cost: {
          input: 0.2,
          output: 1.2,
          cache_read: 0.02,
          cache_write: 0.25,
        },
      },
      "gpt-5.3-codex": {
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high", "xhigh"],
          },
        ],
        tool_call: true,
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        cost: {
          input: 1.75,
          output: 14,
          cache_read: 0.175,
        },
      },
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        reasoning: false,
        tool_call: true,
        limit: {
          context: 128000,
          output: 16384,
        },
        cost: {
          input: 0.15,
          output: 0.6,
          cache_read: 0.075,
        },
      },
      "gpt-image-1.5": {
        id: "gpt-image-1.5",
        name: "gpt-image-1.5",
        reasoning: false,
        tool_call: false,
        limit: {
          context: 0,
          input: 0,
          output: 0,
        },
      },
      "o1-pro": {
        id: "o1-pro",
        name: "o1-pro",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high"],
          },
        ],
        tool_call: true,
        limit: {
          context: 200000,
          output: 100000,
        },
        cost: {
          input: 150,
          output: 600,
        },
      },
      "gpt-4.1": {
        id: "gpt-4.1",
        name: "GPT-4.1",
        reasoning: false,
        tool_call: true,
        limit: {
          context: 1047576,
          output: 32768,
        },
        cost: {
          input: 2,
          output: 8,
          cache_read: 0.5,
        },
      },
      "text-embedding-ada-002": {
        id: "text-embedding-ada-002",
        name: "text-embedding-ada-002",
        reasoning: false,
        tool_call: false,
        limit: {
          context: 8192,
          output: 1536,
        },
        cost: {
          input: 0.1,
          output: 0,
        },
      },
      "gpt-image-1": {
        id: "gpt-image-1",
        name: "gpt-image-1",
        reasoning: false,
        tool_call: false,
        limit: {
          context: 0,
          input: 0,
          output: 0,
        },
      },
      "gpt-5.4-nano": {
        id: "gpt-5.4-nano",
        name: "GPT-5.4 nano",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high", "xhigh"],
          },
        ],
        tool_call: true,
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        cost: {
          input: 0.2,
          output: 1.25,
          cache_read: 0.02,
        },
      },
      "gpt-5.5-pro": {
        id: "gpt-5.5-pro",
        name: "GPT-5.5 Pro",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["medium", "high", "xhigh"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        cost: {
          input: 30,
          output: 180,
        },
      },
      "gpt-image-1-mini": {
        id: "gpt-image-1-mini",
        name: "gpt-image-1-mini",
        reasoning: false,
        tool_call: false,
        limit: {
          context: 0,
          input: 0,
          output: 0,
        },
      },
      "gpt-5.4-mini": {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high", "xhigh"],
          },
        ],
        tool_call: true,
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        cost: {
          input: 0.75,
          output: 4.5,
          cache_read: 0.075,
        },
      },
      "gpt-image-2": {
        id: "gpt-image-2",
        name: "gpt-image-2",
        reasoning: false,
        tool_call: false,
        limit: {
          context: 0,
          input: 0,
          output: 0,
        },
        cost: {
          input: 5,
          output: 30,
          cache_read: 1.25,
        },
      },
      "gpt-3.5-turbo": {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5-turbo",
        reasoning: false,
        tool_call: false,
        limit: {
          context: 16385,
          output: 4096,
        },
        cost: {
          input: 0.5,
          output: 1.5,
          cache_read: 0,
        },
      },
      "gpt-5.6": {
        id: "gpt-5.6",
        name: "GPT-5.6",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high", "xhigh", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        cost: {
          input: 4,
          output: 20,
          cache_read: 0.4,
          cache_write: 5,
        },
      },
      "text-embedding-3-small": {
        id: "text-embedding-3-small",
        name: "text-embedding-3-small",
        reasoning: false,
        tool_call: false,
        limit: {
          context: 8191,
          output: 1536,
        },
        cost: {
          input: 0.02,
          output: 0,
        },
      },
      "gpt-5-mini": {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["minimal", "low", "medium", "high"],
          },
        ],
        tool_call: true,
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        cost: {
          input: 0.25,
          output: 2,
          cache_read: 0.025,
        },
      },
      "gpt-5.4-pro": {
        id: "gpt-5.4-pro",
        name: "GPT-5.4 Pro",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["medium", "high", "xhigh"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        cost: {
          input: 30,
          output: 180,
        },
      },
      "text-embedding-3-large": {
        id: "text-embedding-3-large",
        name: "text-embedding-3-large",
        reasoning: false,
        tool_call: false,
        limit: {
          context: 8191,
          output: 3072,
        },
        cost: {
          input: 0.13,
          output: 0,
        },
      },
      "gpt-5.6-terra": {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high", "xhigh", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        cost: {
          input: 2,
          output: 12,
          cache_read: 0.2,
          cache_write: 2.5,
        },
      },
      "gpt-4": {
        id: "gpt-4",
        name: "GPT-4",
        reasoning: false,
        tool_call: true,
        limit: {
          context: 8192,
          output: 8192,
        },
        cost: {
          input: 30,
          output: 60,
        },
      },
      "gpt-5.2": {
        id: "gpt-5.2",
        name: "GPT-5.2",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high", "xhigh"],
          },
        ],
        tool_call: true,
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        cost: {
          input: 1.75,
          output: 14,
          cache_read: 0.175,
        },
      },
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["minimal", "low", "medium", "high"],
          },
        ],
        tool_call: true,
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        cost: {
          input: 1.25,
          output: 10,
          cache_read: 0.125,
        },
      },
      "gpt-5.2-chat-latest": {
        id: "gpt-5.2-chat-latest",
        name: "GPT-5.2 Chat",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["medium"],
          },
        ],
        tool_call: true,
        limit: {
          context: 128000,
          output: 16384,
        },
        cost: {
          input: 1.75,
          output: 14,
          cache_read: 0.175,
        },
      },
      "o4-mini": {
        id: "o4-mini",
        name: "o4-mini",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high"],
          },
        ],
        tool_call: true,
        limit: {
          context: 200000,
          output: 100000,
        },
        cost: {
          input: 1.1,
          output: 4.4,
          cache_read: 0.275,
        },
      },
      "gpt-realtime-2.1": {
        id: "gpt-realtime-2.1",
        name: "GPT-Realtime-2.1",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["minimal", "low", "medium", "high", "xhigh"],
          },
        ],
        tool_call: true,
        limit: {
          context: 128000,
          input: 96000,
          output: 32000,
        },
        cost: {
          input: 4,
          output: 24,
          cache_read: 0.4,
        },
      },
      "o3-mini": {
        id: "o3-mini",
        name: "o3-mini",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high"],
          },
        ],
        tool_call: true,
        limit: {
          context: 200000,
          output: 100000,
        },
        cost: {
          input: 1.1,
          output: 4.4,
          cache_read: 0.55,
        },
      },
      o3: {
        id: "o3",
        name: "o3",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high"],
          },
        ],
        tool_call: true,
        limit: {
          context: 200000,
          output: 100000,
        },
        cost: {
          input: 2,
          output: 8,
          cache_read: 0.5,
        },
      },
      "o3-pro": {
        id: "o3-pro",
        name: "o3-pro",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high"],
          },
        ],
        tool_call: true,
        limit: {
          context: 200000,
          output: 100000,
        },
        cost: {
          input: 20,
          output: 80,
        },
      },
      "gpt-5.3-chat-latest": {
        id: "gpt-5.3-chat-latest",
        name: "GPT-5.3 Chat (latest)",
        reasoning: false,
        tool_call: true,
        limit: {
          context: 128000,
          output: 16384,
        },
        cost: {
          input: 1.75,
          output: 14,
          cache_read: 0.175,
        },
      },
      "gpt-5.5": {
        id: "gpt-5.5",
        name: "GPT-5.5",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["none", "low", "medium", "high", "xhigh"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        cost: {
          input: 5,
          output: 30,
          cache_read: 0.5,
        },
      },
      "gpt-4o-2024-11-20": {
        id: "gpt-4o-2024-11-20",
        name: "GPT-4o (2024-11-20)",
        reasoning: false,
        tool_call: true,
        limit: {
          context: 128000,
          output: 16384,
        },
        cost: {
          input: 2.5,
          output: 10,
          cache_read: 1.25,
        },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high", "max"],
          },
          {
            type: "budget_tokens",
            min: 1024,
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 3,
          output: 15,
          cache_read: 0.3,
          cache_write: 3.75,
        },
      },
      "claude-opus-5": {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          cache_write: 6.25,
        },
      },
      "claude-opus-4-5": {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5 (latest)",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high"],
          },
          {
            type: "budget_tokens",
            min: 1024,
          },
        ],
        tool_call: true,
        limit: {
          context: 200000,
          output: 64000,
        },
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          cache_write: 6.25,
        },
      },
      "claude-fable-5-1": {
        id: "claude-fable-5-1",
        name: "Claude Fable 5.1",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 10,
          output: 50,
          cache_read: 0.25,
          cache_write: 12.5,
        },
      },
      "claude-opus-4-6": {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high", "max"],
          },
          {
            type: "budget_tokens",
            min: 1024,
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          cache_write: 6.25,
        },
      },
      "claude-sonnet-4-5-20250929": {
        id: "claude-sonnet-4-5-20250929",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        reasoning_options: [
          {
            type: "budget_tokens",
            min: 1024,
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 64000,
        },
        cost: {
          input: 3,
          output: 15,
          cache_read: 0.3,
          cache_write: 3.75,
        },
      },
      "claude-opus-4-7": {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          cache_write: 6.25,
        },
      },
      "claude-haiku-4-5-20251001": {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
        reasoning: true,
        reasoning_options: [
          {
            type: "budget_tokens",
            min: 1024,
          },
        ],
        tool_call: true,
        limit: {
          context: 200000,
          output: 64000,
        },
        cost: {
          input: 1,
          output: 5,
          cache_read: 0.1,
          cache_write: 1.25,
        },
      },
      "claude-fable-5": {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 10,
          output: 50,
          cache_read: 1,
          cache_write: 12.5,
        },
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5 (latest)",
        reasoning: true,
        reasoning_options: [
          {
            type: "budget_tokens",
            min: 1024,
          },
        ],
        tool_call: true,
        limit: {
          context: 200000,
          output: 64000,
        },
        cost: {
          input: 1,
          output: 5,
          cache_read: 0.1,
          cache_write: 1.25,
        },
      },
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5 (latest)",
        reasoning: true,
        reasoning_options: [
          {
            type: "budget_tokens",
            min: 1024,
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 64000,
        },
        cost: {
          input: 3,
          output: 15,
          cache_read: 0.3,
          cache_write: 3.75,
        },
      },
      "claude-opus-4-8": {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          cache_write: 6.25,
        },
      },
      "claude-sonnet-5": {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        reasoning: true,
        reasoning_options: [
          {
            type: "toggle",
          },
          {
            type: "effort",
            values: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
        tool_call: true,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.2,
          cache_write: 2.5,
        },
      },
      "claude-opus-4-5-20251101": {
        id: "claude-opus-4-5-20251101",
        name: "Claude Opus 4.5",
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: ["low", "medium", "high"],
          },
          {
            type: "budget_tokens",
            min: 1024,
          },
        ],
        tool_call: true,
        limit: {
          context: 200000,
          output: 64000,
        },
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          cache_write: 6.25,
        },
      },
    },
  },
};

import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import type {
  LocalToolInfo,
  MessageInsert,
  MessageRow,
  Part,
  ToolEventInfo,
  ToolInfo,
} from "../../_shared/supabase.ts";
import {
  type AgentProtocolHandler,
  contextHeaders,
  type RequestContext,
  type ResponseContext,
} from "./base.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentTool } from "../index.ts";
import * as log from "../../_shared/logger.ts";
import { getFileMetadata } from "../../_shared/media.ts";
import { serializePartAsXML } from "./serializer.ts";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { inspect } from "node:util";
import { getTimezoneFromPhone } from "../../_shared/phone.ts";
dayjs.extend(utc);
dayjs.extend(timezone);

const RESPOND_FUNCTION_NAME = "respond";

const RESPOND_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: RESPOND_FUNCTION_NAME,
    description:
      'Send a message to the user. Keep messages short — one or two sentences, like a quick chat message, never long paragraphs. Use this sparingly: do NOT send a message after every tool call. While working through several tools, send at most one brief heads-up (e.g. "One sec, checking availability…") and then one short message with the result. Also use it to attach a file or to split a reply into a couple of separate short messages. Never use this to report or apologize for a tool failure or error: when a tool call fails, stay silent and simply retry it correctly — the user should not be told that something went wrong behind the scenes.',
    parameters: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["text"] },
                  text: { type: "string" },
                },
                required: ["type", "text"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["file"] },
                  uri: { type: "string", description: "internal:// file URI" },
                  name: { type: "string" },
                  text: { type: "string", description: "Optional caption" },
                },
                required: ["type", "uri"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      additionalProperties: false,
    },
  },
};

export interface ChatCompletionsRequest {
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
}

export interface ChatCompletionsResponse {
  finish_reason: ChatCompletion["choices"][number]["finish_reason"];
  message: ChatCompletionMessage;
}

export class ChatCompletionsHandler
  implements
    AgentProtocolHandler<ChatCompletionsRequest, ChatCompletionsResponse> {
  private tools: AgentTool[];
  private context: RequestContext;
  private client: SupabaseClient;
  private FUNCTION_NAME_SEPARATOR = "__";
  private messagesByExternalId = new Map<string, MessageRow>();

  constructor(
    tools: AgentTool[],
    context: RequestContext,
    client: SupabaseClient,
  ) {
    this.tools = tools;
    this.context = context;
    this.client = client;
  }

  /**
   * An assistant message with 'tool_calls' must be followed by
   * tool messages responding to each 'tool_call_id'.
   *
   * The problem is that the tool messages order is not guaranteed.
   */
  private sortToolMessages(messages: MessageRow[]): MessageRow[] {
    const taskMap = new Map<
      string,
      {
        uses: MessageRow[];
        results: MessageRow[];
      }
    >();

    const withoutTools: MessageRow[] = [];

    for (const row of messages) {
      if (row.direction === "internal" && row.content.tool) {
        const taskId = row.content.task?.id;

        if (!taskId) {
          throw new Error("Task id is required");
        }

        let task = taskMap.get(taskId);

        if (!task) {
          task = {
            uses: [],
            results: [],
          };

          taskMap.set(taskId, task);
        }

        if (row.content.tool.event === "use") {
          if (!task.uses.length) {
            // Use the first appeareance of a tool use within a task as a placeholder.
            withoutTools.push(row);
          }

          task.uses.push(row);
        } else {
          task.results.push(row);
        }

        continue;
      }

      withoutTools.push(row);
    }

    const sorted: MessageRow[] = [];

    for (const row of withoutTools) {
      if (row.direction === "internal" && row.content.tool) {
        const taskId = row.content.task!.id;

        const task = taskMap.get(taskId)!;

        sorted.push(...task.uses, ...task.results);

        continue;
      }

      sorted.push(row);
    }

    return sorted;
  }

  private removeOtherAgentsToolMessages(messages: MessageRow[]): MessageRow[] {
    return messages.filter((message) => {
      if (message.direction === "internal" && message.content.tool) {
        return message.agent_id === this.context.agent.id;
      }

      return true;
    });
  }

  private removeUnpairedToolMessages(messages: MessageRow[]): MessageRow[] {
    const toolUseSet = new Set<string>();
    const pairedToolUseSet = new Set<string>();

    for (const message of messages) {
      if (message.direction === "internal" && message.content.tool) {
        const toolUseId = message.content.tool.use_id;

        if (toolUseSet.has(toolUseId)) {
          pairedToolUseSet.add(toolUseId);
        } else {
          toolUseSet.add(toolUseId);
        }
      }
    }

    return messages.filter((message) => {
      if (message.direction === "internal" && message.content.tool) {
        return pairedToolUseSet.has(message.content.tool.use_id);
      }

      return true;
    });
  }

  /**
   * Expects tool messages to be sorted.
   */
  private mergeToolUseMessages(
    messages: MessageRow[],
  ): ChatCompletionMessageParam[] {
    const messageParams: ChatCompletionMessageParam[] = [];

    for (const row of messages) {
      const lastParam = messageParams.at(-1);

      const param = this.toChatCompletion(row);

      if (
        lastParam &&
        "tool_calls" in lastParam &&
        Array.isArray(lastParam.tool_calls) &&
        "tool_calls" in param &&
        Array.isArray(param.tool_calls)
      ) {
        lastParam.tool_calls.push(...param.tool_calls);

        continue;
      }

      messageParams.push(param);
    }

    return messageParams;
  }

  /**
   * Chat Completions does not keep the message history of the conversation.
   * That's why we do not send files but some text representation of them.
   * It would be costly to send the same files over and over again during the conversation.
   */
  private toChatCompletion(
    row: MessageRow,
  ): ChatCompletionMessageParam {
    const part = row.content as Part & ToolInfo;
    const role = row.agent_id === this.context.agent.id ? "assistant" : "user";

    if (part.tool?.provider === "local") {
      if (part.tool.event === "use") {
        const name = ["label" in part.tool && part.tool.label, part.tool.name]
          .filter(Boolean)
          .join(this.FUNCTION_NAME_SEPARATOR);

        if (part.type === "data") {
          const toolCall: ChatCompletionMessageToolCall = {
            id: part.tool.use_id,
            function: {
              name,
              arguments: JSON.stringify(part.data),
            },
            type: "function",
          };

          const message: ChatCompletionAssistantMessageParam = {
            role: "assistant",
            tool_calls: [toolCall],
          };

          return message;
        }

        if (part.type === "text") {
          const toolCall: ChatCompletionMessageToolCall = {
            id: part.tool.use_id,
            custom: {
              name,
              input: part.text,
            },
            type: "custom",
          };

          const message: ChatCompletionAssistantMessageParam = {
            role: "assistant",
            tool_calls: [toolCall],
          };

          return message;
        }
      }

      if (part.tool.event === "result") {
        if (part.type === "data") {
          const message: ChatCompletionToolMessageParam = {
            role: "tool",
            content: JSON.stringify(part.data),
            tool_call_id: part.tool.use_id,
          };

          return message;
        }

        if (part.type === "text") {
          const message: ChatCompletionToolMessageParam = {
            role: "tool",
            content: part.text,
            tool_call_id: part.tool.use_id,
          };

          return message;
        }
      }
    }

    let serialized = serializePartAsXML(part);

    if (row.content.re_message_id) {
      const refMessage = this.messagesByExternalId.get(
        row.content.re_message_id,
      );

      if (refMessage) {
        const tag = part.type === "text" && part.kind === "reaction"
          ? "in-reaction-to"
          : "in-reply-to";
        const snippet = serializePartAsXML(
          refMessage.content as Part & ToolInfo,
        );
        serialized = `<${tag}>${snippet}</${tag}>\n${serialized}`;
      }
    }

    return {
      role,
      content: serialized,
    };
  }

  prepareRequest(): Promise<ChatCompletionsRequest> {
    let { messages, agent } = this.context;

    const max = agent.extra.max_messages;

    if (max && messages.length > max) {
      // TODO: Watch out for tools/tasks requests and responses, it would make no sense to cut the message
      // history after the request and before the response.
      messages = messages.slice(-max);
    }

    // TODO: Commented out, waiting for multi-agent support.
    //messages = this.removeOtherAgentsToolMessages(messages);
    // TODO: remove tool messages of missing tool definitions (this.tools)?
    // They tend to confuse the model with unexpected tool calls.
    // Build external_id index for reply/reaction context resolution
    this.messagesByExternalId = new Map(
      messages
        .filter((m): m is MessageRow & { external_id: string } =>
          !!m.external_id
        )
        .map((m) => [m.external_id, m]),
    );

    messages = this.removeUnpairedToolMessages(messages);
    messages = this.sortToolMessages(messages);

    const chatCompletionMessages = this.mergeToolUseMessages(messages);

    // Render "now" in the contact's local time (inferred from their phone's
    // country calling code) so the agent reasons about the user's clock, not
    // the server's. Falls back to UTC when the timezone can't be inferred.
    const contactAddress = this.context.conversation.contact_address;
    const userTimezone = getTimezoneFromPhone(contactAddress);
    const now = userTimezone ? dayjs().tz(userTimezone) : dayjs().utc();

    const context = {
      // `Z` (UTC offset, e.g. +03:00) rather than `z` — the timezone-name
      // token isn't supported by this dayjs build and would render literally.
      now: now.format("YYYY-MM-DD HH:mm Z"),
      user: {
        name: this.context.contact?.name,
        phone: contactAddress ? "+" + contactAddress : undefined,
        email: this.context.contact?.email ?? undefined,
      },
    };

    let content = inspect(context, {
      compact: false,
      depth: Infinity,
      colors: false,
    });

    if (agent.extra.instructions) {
      content = agent.extra.instructions + "\n\n" + content;
    }

    chatCompletionMessages.unshift({
      role: "system",
      content,
    });

    const chatCompletionTools: ChatCompletionTool[] = this.tools.map((
      tool,
    ) => ({
      type: "function" as const,
      function: {
        name: ["label" in tool && tool.label, tool.name]
          .filter(Boolean)
          .join(this.FUNCTION_NAME_SEPARATOR),
        description: tool.description,
        parameters: tool.inputSchema,
        /**
         * NOTE:
         * - For each object in the parameters schema, set `additionalProperties: false`.
         * - All fields in `properties` must be included in `required`.
         * - To denote optional fields, add `null` as a type option in the schema.
         * - Anthropic does not support (ignores) `strict` mode.
         */
        //strict: true,
      },
    }));

    chatCompletionTools.push(RESPOND_TOOL);

    return Promise.resolve({
      messages: chatCompletionMessages,
      tools: chatCompletionTools,
    });
  }

  private calculateCost(
    usage: ChatCompletion["usage"],
    pricing: Record<string, number>,
    quantity: number,
  ): number {
    if (!usage) return 0;

    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const audio_in = usage.prompt_tokens_details?.audio_tokens ?? 0;
    const audio_out = usage.completion_tokens_details?.audio_tokens ?? 0;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;

    const cost = (prompt - cached - audio_in) * (pricing.input ?? 0) +
      cached * (pricing.cache_read ?? pricing.input ?? 0) +
      audio_in * (pricing.audio_input ?? pricing.input ?? 0) +
      (completion - reasoning - audio_out) * (pricing.output ?? 0) +
      reasoning * (pricing.reasoning ?? pricing.output ?? 0) +
      audio_out * (pricing.audio_output ?? pricing.output ?? 0);

    return cost / quantity;
  }

  async sendRequest(
    request: ChatCompletionsRequest,
  ): Promise<ChatCompletionsResponse> {
    const { agent, organization } = this.context;

    let provider = agent.extra.api_url;
    let baseURL = agent.extra.api_url;
    let apiKey = agent.extra.api_key;
    let model = agent.extra.model;

    switch (baseURL) {
      case "groq":
        baseURL = "https://api.groq.com/openai/v1";
        apiKey ||= Deno.env.get("GROQ_API_KEY");
        model ||= "openai/gpt-oss-20b";
        break;
      case "anthropic":
        baseURL = "https://api.anthropic.com/v1";
        apiKey ||= Deno.env.get("ANTHROPIC_API_KEY");
        model ||= "claude-sonnet-4-6";
        break;
      case "google":
        baseURL = "https://generativelanguage.googleapis.com/v1beta/openai";
        apiKey ||= Deno.env.get("GOOGLE_API_KEY");
        model ||= "gemini-3-flash-preview";
        break;
      case "openai":
        // undefined makes OpenAI use the default base URL
        // and api key from the OPENAI_API_KEY environment variable.
        baseURL = undefined;
      /* falls through */
      default:
        // remove /chat/completions from the base URL if it exists,
        // the client appends it automatically.
        baseURL = baseURL?.replace("/chat/completions", "") || undefined;
        apiKey ||= undefined;
        model ||= "gpt-5-mini";
        provider = !!baseURL && baseURL !== "openai" ? "custom" : "openai";
    }
    // Note: for Bedrock, the base URL is https://${bedrock-runtime-endpoint}/openai/v1

    const billable = !agent.extra.api_key;

    // Fetch cost pricing and check the credit balance concurrently before the
    // LLM call. These two queries are independent, so running them in parallel
    // removes one serial round-trip from the time-to-first-token.
    const [{ data: costs }] = await Promise.all([
      this.client
        .schema("billing")
        .from("costs")
        .select("pricing, quantity")
        .eq("provider", provider)
        .eq("product", model)
        .lte("effective_at", new Date().toISOString())
        .order("effective_at", { ascending: false })
        .limit(1)
        .maybeSingle()
        .throwOnError(),
      // Check AI credits balance (only when we are the ones billing).
      billable
        ? this.client
          .schema("billing")
          .rpc("check_limit", {
            _organization_id: organization.id,
            _product_id: "ai_credits",
            _amount: 0,
          })
          .throwOnError()
        : Promise.resolve(null),
    ]);

    // Block if we don't have pricing for a model we are billing.
    if (billable && !costs) {
      throw new Error(`No pricing found for ${provider}/${model}`);
    }

    const openai = new OpenAI({
      baseURL,
      apiKey,
      timeout: 30000, // 30 seconds
      maxRetries: 2,
      defaultHeaders: contextHeaders(this.context),
    });

    let response;

    let retries = 0;
    const maxRetries = 3;

    while (true) {
      try {
        response = await openai.chat.completions.create({
          model,
          temperature: agent.extra.temperature ?? undefined,
          max_completion_tokens: agent.extra.max_tokens ?? undefined,
          messages: request.messages,
          // TOOLS
          tools: request.tools.length ? request.tools : undefined,
          tool_choice: "auto",
          parallel_tool_calls: request.tools.length ? true : undefined,
          // THINKING
          // ts-expect-error
          //thinking: { type: "enabled", budget_tokens: 2000 },
          //reasoning_effort: agent.extra.thinking || "low",
        });

        break;
      } catch (error) {
        if (
          retries < maxRetries &&
          error instanceof Error &&
          "status" in error &&
          error.status === 400
        ) {
          log.warn(`Retrying with error context... ${error.message}`);

          // Create a defensive copy of messages to ensure we don't mutate the original request
          const messages = [...request.messages];

          messages.push({
            role: "user", // Phantom message
            content: `Previous request failed with error: ${error.message}`,
          });

          // Update the request reference to use the new messages array for the next iteration
          request = { ...request, messages };

          retries++;
          continue;
        }

        throw error;
      }
    }

    // Record AI usage in the ledger
    if (response.usage) {
      const cost = costs
        ? this.calculateCost(
          response.usage,
          costs.pricing as Record<string, number>,
          costs.quantity,
        )
        : 0;

      await this.client
        .schema("billing")
        .from("ledger")
        .insert({
          organization_id: organization.id,
          product_id: "ai_credits",
          type: "consumption",
          quantity: -cost,
          agent_id: agent.id,
          provider,
          model,
          billable,
          metadata: response.usage,
        })
        .throwOnError();
    }

    return {
      finish_reason: response.choices[0].finish_reason,
      message: response.choices[0].message,
    };
  }

  private toOutgoingText(text: string): MessageInsert {
    const { agent, conversation } = this.context;

    return {
      organization_id: conversation.organization_id,
      service: conversation.service,
      organization_address: conversation.organization_address,
      contact_address: conversation.contact_address,
      direction: "outgoing",
      agent_id: agent.id,
      content: {
        version: "1",
        type: "text",
        kind: "text",
        text,
      },
    };
  }

  private async processRespondCall(
    respondCall: ChatCompletionMessageToolCall,
  ): Promise<MessageInsert[]> {
    const { agent, conversation } = this.context;

    if (respondCall.type !== "function") {
      return [];
    }

    const args = JSON.parse(respondCall.function.arguments) as {
      messages: Array<
        | { type: "text"; text: string }
        | { type: "file"; uri: string; name?: string; text?: string }
      >;
    };

    if (!args.messages?.length) {
      log.info("Respond called with empty messages. No response to user.");
      return [];
    }

    const outgoing: MessageInsert[] = [];

    for (const msg of args.messages) {
      if (msg.type === "text") {
        outgoing.push({
          organization_id: conversation.organization_id,
          service: conversation.service,
          organization_address: conversation.organization_address,
          contact_address: conversation.contact_address,
          direction: "outgoing",
          agent_id: agent.id,
          content: {
            version: "1",
            type: "text",
            kind: "text",
            text: msg.text,
          },
        });
      } else if (msg.type === "file") {
        const file = await getFileMetadata(this.client, msg.uri);

        if (msg.name) {
          file.name = msg.name;
        }

        const mimePrefix = file.mime_type.split("/")[0];
        const kind = (
          ["audio", "image", "video"].includes(mimePrefix)
            ? mimePrefix
            : "document"
        ) as "audio" | "image" | "video" | "document";

        outgoing.push({
          organization_id: conversation.organization_id,
          service: conversation.service,
          organization_address: conversation.organization_address,
          contact_address: conversation.contact_address,
          direction: "outgoing",
          agent_id: agent.id,
          content: {
            version: "1",
            type: "file",
            kind,
            file,
            text: msg.text,
          },
        });
      }
    }

    return outgoing;
  }

  async processResponse(
    response: ChatCompletionsResponse,
  ): Promise<ResponseContext> {
    const { finish_reason, message } = response;
    const { agent, conversation } = this.context;

    if (finish_reason === "tool_calls" && message.tool_calls?.length) {
      const messages: MessageInsert[] = [];

      // 1. Narration the model emitted alongside its tool calls is shown to the
      //    user immediately, enabling mid-loop updates ("Let me check...").
      if (message.content) {
        messages.push(this.toOutgoingText(message.content));
      }

      // 2. The virtual `respond` tool is a user-facing message, not a terminal
      //    action: emit its messages but keep processing real tool calls so the
      //    agent can both reply and continue working in the same turn.
      const respondCalls = message.tool_calls.filter(
        (tc) =>
          tc.type === "function" && tc.function.name === RESPOND_FUNCTION_NAME,
      );

      for (const respondCall of respondCalls) {
        messages.push(...(await this.processRespondCall(respondCall)));
      }

      // 3. Real (non-respond) tool calls drive the agent loop's continuation.
      const realCalls = message.tool_calls.filter(
        (tc) =>
          !(tc.type === "function" &&
            tc.function.name === RESPOND_FUNCTION_NAME),
      );

      const taskId = crypto.randomUUID();

      messages.push(...realCalls.map((toolCall): MessageInsert => {
        let tool: ToolEventInfo & LocalToolInfo;
        let name: string;
        let text: string;

        if (toolCall.type === "custom") {
          name = toolCall.custom.name;
          text = toolCall.custom.input;
        } else {
          name = toolCall.function.name;
          text = toolCall.function.arguments;
        }

        if (name.includes(this.FUNCTION_NAME_SEPARATOR)) {
          const [label, _name] = name.split(this.FUNCTION_NAME_SEPARATOR);

          const toolInfo = this.tools.find(
            (t) => t.label === label && t.name === _name,
          );

          tool = {
            use_id: toolCall.id,
            event: "use",
            provider: "local",
            // Default: Pick any type. Function name check is performed elsewhere.
            type: (toolInfo?.type || "mcp") as "mcp" | "sql" | "http",
            label,
            name: _name,
          };
        } else {
          const toolInfo = this.tools.find((t) => t.name === name);

          tool = {
            use_id: toolCall.id,
            event: "use",
            provider: "local",
            type: (toolInfo?.type as "function" | "custom") || "function",
            name,
          };
        }

        return {
          organization_id: conversation.organization_id,
          service: conversation.service,
          organization_address: conversation.organization_address,
          contact_address: conversation.contact_address,
          direction: "internal" as const,
          agent_id: agent.id,
          content: {
            version: "1" as const,
            task: {
              // This id will be used to merge all the tool calls together
              // in one single message during prepareRequest().
              id: taskId,
            },
            tool: tool!,
            type: "text" as const,
            kind: "text" as const,
            // Note: Function arguments are parsed during tool handling.
            // TODO: custom tool input is text (do not parse).
            text,
          },
        };
      }));

      return { messages };
    }

    // TODO: finish reasons: length, content filter

    if (finish_reason === "stop" && message.content) {
      // With tool_choice "auto" a plain-text answer is the normal way to end a
      // turn, so this is a first-class response path.
      return { messages: [this.toOutgoingText(message.content)] };
    }

    return {
      messages: [],
    };
  }
}

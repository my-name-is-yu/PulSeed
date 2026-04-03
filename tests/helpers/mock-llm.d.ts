import type { ZodSchema } from "zod";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../src/base/llm/llm-client.js";
declare class MockLLMClient implements ILLMClient {
    private readonly responses;
    private _callCount;
    private readonly _onCall;
    constructor(responses: string[], onCall?: () => void);
    get callCount(): number;
    sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse>;
    parseJSON<T>(content: string, schema: ZodSchema<T>): T;
}
/**
 * Create a mock ILLMClient that returns responses sequentially from the array.
 * Throws a descriptive error when responses are exhausted.
 * Exposes a `callCount` getter to track sendMessage invocations.
 *
 * Optional `onCall` callback is invoked after each sendMessage call (useful
 * for stopping a daemon from within the mock to avoid real-time waits).
 */
export declare function createMockLLMClient(responses: string[], onCall?: () => void): MockLLMClient;
/**
 * Convenience wrapper for a single-response mock.
 */
export declare function createSingleMockLLMClient(response: string): MockLLMClient;
export {};
//# sourceMappingURL=mock-llm.d.ts.map
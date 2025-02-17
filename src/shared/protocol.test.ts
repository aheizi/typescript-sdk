import { ZodType, z } from "zod";
import {
  ClientCapabilities,
  ErrorCode,
  McpError,
  Notification,
  Request,
  Result,
  ServerCapabilities,
} from "../types.js";
import { Protocol, mergeCapabilities } from "./protocol.js";
import { Transport } from "./transport.js";

// Mock Transport class
class MockTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;

  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
  async send(_message: unknown): Promise<void> {}
}

describe("protocol tests", () => {
  let protocol: Protocol<Request, Notification, Result>;
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
    protocol = new (class extends Protocol<Request, Notification, Result> {
      protected assertCapabilityForMethod(): void {}
      protected assertNotificationCapability(): void {}
      protected assertRequestHandlerCapability(): void {}
    })();
  });

  test("should throw a timeout error if the request exceeds the timeout", async () => {
    await protocol.connect(transport);
    const request = { method: "example", params: {} };
    try {
      const mockSchema: ZodType<{ result: string }> = z.object({
        result: z.string(),
      });
      await protocol.request(request, mockSchema, {
        timeout: 0,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      if (error instanceof McpError) {
        expect(error.code).toBe(ErrorCode.RequestTimeout);
      }
    }
  });

  test("should invoke onclose when the connection is closed", async () => {
    const oncloseMock = jest.fn();
    protocol.onclose = oncloseMock;
    await protocol.connect(transport);
    await transport.close();
    expect(oncloseMock).toHaveBeenCalled();
  });

  test("should reset timeout when progress notification is received", async () => {
    jest.useFakeTimers();
    
    await protocol.connect(transport);
    const request = { method: "example", params: {} };
    const mockSchema: ZodType<{ result: string }> = z.object({
      result: z.string(),
    });

    const onProgressMock = jest.fn();
    const requestPromise = protocol.request(request, mockSchema, {
      timeout: 1000,  // Increased timeout for more reliable testing
      resetTimeoutOnProgress: true,
      onprogress: onProgressMock,
    });

    // Advance time close to timeout
    jest.advanceTimersByTime(800);

    // Send progress notification
    if (transport.onmessage) {
      transport.onmessage({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: 0,
          progress: 50,
          total: 100,
        },
      });
    }

    // Run all pending promises to ensure progress handler is called
    await Promise.resolve();

    // Verify progress handler was called
    expect(onProgressMock).toHaveBeenCalledWith({
      progress: 50,
      total: 100,
    });

    // Send success response
    if (transport.onmessage) {
      transport.onmessage({
        jsonrpc: "2.0",
        id: 0,
        result: { result: "success" },
      });
    }

    // Run all pending promises
    await Promise.resolve();

    await expect(requestPromise).resolves.toEqual({ result: "success" });

    jest.useRealTimers();
  });

  test("should respect maxTotalTimeout", async () => {
    jest.useFakeTimers();
    
    await protocol.connect(transport);
    const request = { method: "example", params: {} };
    const mockSchema: ZodType<{ result: string }> = z.object({
      result: z.string(),
    });

    const onProgressMock = jest.fn();
    const requestPromise = protocol.request(request, mockSchema, {
      timeout: 1000,
      maxTotalTimeout: 100,
      resetTimeoutOnProgress: true,
      onprogress: onProgressMock,
    });

    // Advance time beyond maxTotalTimeout
    jest.advanceTimersByTime(150);

    // Send progress notification after maxTotalTimeout
    if (transport.onmessage) {
      transport.onmessage({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: 0,
          progress: 50,
          total: 100,
        },
      });
    }

    await expect(requestPromise).rejects.toThrow("Maximum total timeout exceeded");
    expect(onProgressMock).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  test("should timeout if no progress received within timeout period", async () => {
    jest.useFakeTimers();
    
    await protocol.connect(transport);
    const request = { method: "example", params: {} };
    const mockSchema: ZodType<{ result: string }> = z.object({
      result: z.string(),
    });

    const requestPromise = protocol.request(request, mockSchema, {
      timeout: 100,
      resetTimeoutOnProgress: true,
    });

    // Advance time beyond timeout
    jest.advanceTimersByTime(101);

    await expect(requestPromise).rejects.toThrow("Request timed out");

    jest.useRealTimers();
  });

  test("should handle multiple progress notifications correctly", async () => {
    jest.useFakeTimers();
    
    await protocol.connect(transport);
    const request = { method: "example", params: {} };
    const mockSchema: ZodType<{ result: string }> = z.object({
      result: z.string(),
    });

    const onProgressMock = jest.fn();
    const requestPromise = protocol.request(request, mockSchema, {
      timeout: 1000,
      resetTimeoutOnProgress: true,
      onprogress: onProgressMock,
    });

    // Simulate multiple progress updates
    for (let i = 1; i <= 3; i++) {
      // Advance close to timeout
      jest.advanceTimersByTime(800);

      // Send progress notification
      if (transport.onmessage) {
        transport.onmessage({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: 0,
            progress: i * 25,
            total: 100,
          },
        });
      }

      // Verify progress handler was called
      await Promise.resolve();
      expect(onProgressMock).toHaveBeenNthCalledWith(i, {
        progress: i * 25,
        total: 100,
      });
    }

    // Send success response
    if (transport.onmessage) {
      transport.onmessage({
        jsonrpc: "2.0",
        id: 0,
        result: { result: "success" },
      });
    }

    await Promise.resolve();
    await expect(requestPromise).resolves.toEqual({ result: "success" });

    jest.useRealTimers();
  });
});

describe("mergeCapabilities", () => {
  it("should merge client capabilities", () => {
    const base: ClientCapabilities = {
      sampling: {},
      roots: {
        listChanged: true,
      },
    };

    const additional: ClientCapabilities = {
      experimental: {
        feature: true,
      },
      roots: {
        newProp: true,
      },
    };

    const merged = mergeCapabilities(base, additional);
    expect(merged).toEqual({
      sampling: {},
      roots: {
        listChanged: true,
        newProp: true,
      },
      experimental: {
        feature: true,
      },
    });
  });

  it("should merge server capabilities", () => {
    const base: ServerCapabilities = {
      logging: {},
      prompts: {
        listChanged: true,
      },
    };

    const additional: ServerCapabilities = {
      resources: {
        subscribe: true,
      },
      prompts: {
        newProp: true,
      },
    };

    const merged = mergeCapabilities(base, additional);
    expect(merged).toEqual({
      logging: {},
      prompts: {
        listChanged: true,
        newProp: true,
      },
      resources: {
        subscribe: true,
      },
    });
  });

  it("should override existing values with additional values", () => {
    const base: ServerCapabilities = {
      prompts: {
        listChanged: false,
      },
    };

    const additional: ServerCapabilities = {
      prompts: {
        listChanged: true,
      },
    };

    const merged = mergeCapabilities(base, additional);
    expect(merged.prompts!.listChanged).toBe(true);
  });

  it("should handle empty objects", () => {
    const base = {};
    const additional = {};
    const merged = mergeCapabilities(base, additional);
    expect(merged).toEqual({});
  });
});

import { test, assert } from './helpers.ts';
import { MistralChatClient, type MistralSdk, type MistralSdkFactory } from '../src/features/ai/mistral-client.ts';

test('MistralChatClient : appelle le SDK officiel en mode JSON', async () => {
  let captured: unknown = null;
  const sdk: MistralSdk = {
    chat: {
      complete: async (request) => {
        captured = request;
        return {
          choices: [{ message: { content: '{"items":[{"query":"lait","quantity":1}]}' } }],
        };
      },
    },
  };
  const client = new MistralChatClient({
    apiKey: 'test-key',
    model: 'mistral-small-latest',
    sdk,
  });

  const raw = await client.complete([{ role: 'user', content: 'lait' }]);

  const req = requireCaptured(captured);
  assert.equal(raw, '{"items":[{"query":"lait","quantity":1}]}');
  assert.equal(req.model, 'mistral-small-latest');
  assert.equal(req.responseFormat?.type, 'json_object');
  assert.equal(req.stream, false);
  assert.equal(req.temperature, 0);
});

function requireCaptured(value: unknown): {
  model?: string;
  responseFormat?: { type?: string };
  stream?: boolean;
  temperature?: number;
} {
  assert.ok(value && typeof value === 'object');
  return value as {
    model?: string;
    responseFormat?: { type?: string };
    stream?: boolean;
    temperature?: number;
  };
}

test('MistralChatClient : remonte les erreurs du SDK', async () => {
  const sdk: MistralSdk = {
    chat: {
      complete: async () => {
        throw new Error('Unauthorized');
      },
    },
  };
  const client = new MistralChatClient({
    apiKey: 'test-key',
    model: 'mistral-small-latest',
    sdk,
  });

  await assert.rejects(
    () => client.complete([{ role: 'user', content: 'lait' }]),
    /Unauthorized/,
  );
});

test('MistralChatClient : convertit les URL SDK en string pour React Native', async () => {
  let capturedHooks: Parameters<MistralSdkFactory>[0]['hooks'] | undefined;
  const sdk: MistralSdk = {
    chat: {
      complete: async () => ({
        choices: [{ message: { content: 'ok' } }],
      }),
    },
  };
  const client = new MistralChatClient({
    apiKey: 'test-key',
    model: 'mistral-small-latest',
    sdkFactory: (config) => {
      capturedHooks = config.hooks;
      return sdk;
    },
  });

  await client.completeChat({
    responseFormat: 'text',
    messages: [{ role: 'user', content: 'ping' }],
  });

  assert.ok(capturedHooks);
  const init = capturedHooks.sdkInit({
    baseURL: new URL('https://api.mistral.ai/v1'),
    client: {} as never,
  });
  assert.equal(typeof init.baseURL, 'string');
  assert.equal(init.baseURL, 'https://api.mistral.ai/v1');

  const input = capturedHooks.beforeCreateRequest({} as never, {
    url: new URL('https://api.mistral.ai/v1/chat/completions'),
    options: { method: 'POST' },
  });
  assert.equal(typeof input.url, 'string');
  assert.equal(input.url, 'https://api.mistral.ai/v1/chat/completions');
});

test('MistralChatClient : polyfill AbortSignal.timeout pour React Native', async () => {
  const abortSignal = globalThis.AbortSignal as typeof AbortSignal & {
    timeout?: (milliseconds: number) => AbortSignal;
  };
  const originalTimeout = abortSignal.timeout;
  let restoredDuringCall = false;

  try {
    Object.defineProperty(abortSignal, 'timeout', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const sdk: MistralSdk = {
      chat: {
        complete: async () => {
          restoredDuringCall = typeof abortSignal.timeout === 'function';
          return {
            choices: [{ message: { content: 'ok' } }],
          };
        },
      },
    };
    const client = new MistralChatClient({
      apiKey: 'test-key',
      model: 'mistral-small-latest',
      sdk,
    });

    await client.completeChat({
      responseFormat: 'text',
      messages: [{ role: 'user', content: 'ping' }],
    });

    assert.equal(restoredDuringCall, true);
    assert.equal(typeof abortSignal.timeout, 'function');
    assert.equal(abortSignal.timeout(1).aborted, false);
  } finally {
    Object.defineProperty(abortSignal, 'timeout', {
      configurable: true,
      writable: true,
      value: originalTimeout,
    });
  }
});

test("MistralChatClient : polyfill ReadableStream pour React Native", async () => {
  const globals = globalThis as typeof globalThis & {
    ReadableStream?: typeof ReadableStream;
  };
  const descriptor = Object.getOwnPropertyDescriptor(globals, 'ReadableStream');
  let restoredDuringCall = false;

  try {
    Object.defineProperty(globals, 'ReadableStream', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const sdk: MistralSdk = {
      chat: {
        complete: async () => {
          restoredDuringCall = typeof globals.ReadableStream === 'function';
          return {
            choices: [{ message: { content: 'ok' } }],
          };
        },
      },
    };
    const client = new MistralChatClient({
      apiKey: 'test-key',
      model: 'mistral-small-latest',
      sdk,
    });

    await client.completeChat({
      responseFormat: 'text',
      messages: [{ role: 'user', content: 'ping' }],
    });

    assert.equal(restoredDuringCall, true);
    assert.equal(typeof globals.ReadableStream, 'function');
    const readableStream = globals.ReadableStream;
    assert.ok(readableStream);
    assert.equal({} instanceof readableStream, false);
  } finally {
    if (descriptor) {
      Object.defineProperty(globals, 'ReadableStream', descriptor);
    } else {
      Reflect.deleteProperty(globals, 'ReadableStream');
    }
  }
});

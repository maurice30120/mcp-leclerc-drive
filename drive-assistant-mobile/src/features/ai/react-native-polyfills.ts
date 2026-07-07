export function ensureMistralReactNativeCompatibility(): void {
  ensureAbortSignalTimeout();
  ensureReadableStreamGlobal();
}

function ensureAbortSignalTimeout(): void {
  const abortSignal = globalThis.AbortSignal as
    | (typeof AbortSignal & { timeout?: (milliseconds: number) => AbortSignal })
    | undefined;

  if (!abortSignal || typeof abortSignal.timeout === 'function') return;

  Object.defineProperty(abortSignal, 'timeout', {
    configurable: true,
    writable: true,
    value: (milliseconds: number): AbortSignal => {
      const controller = new AbortController();
      const delay = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
      const timer = setTimeout(() => {
        const reason =
          typeof DOMException === 'function'
            ? new DOMException('The operation timed out.', 'TimeoutError')
            : new Error('The operation timed out.');
        controller.abort(reason);
      }, delay);

      controller.signal.addEventListener('abort', () => clearTimeout(timer), {
        once: true,
      });

      return controller.signal;
    },
  });
}

function ensureReadableStreamGlobal(): void {
  const globals = globalThis as typeof globalThis & {
    ReadableStream?: typeof ReadableStream;
  };

  if (typeof globals.ReadableStream === 'function') return;

  Object.defineProperty(globals, 'ReadableStream', {
    configurable: true,
    writable: true,
    value: class ReadableStreamFallback {},
  });
}

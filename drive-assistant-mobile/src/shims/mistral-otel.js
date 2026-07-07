export function runWithContext(_context, fn) {
  return fn();
}

export async function recordRequestError() {}

export function getOrCreateOtelTracer() {
  return null;
}

export async function getTracedRequestAndSpan(_tracer, _operationId, request) {
  return { request, span: null, body: undefined };
}

export function getSpanContext() {
  return undefined;
}

export function getTracedResponse(_tracer, _span, _operationId, response) {
  return response;
}

export function getResponseAndError(_span, response, error) {
  return { response, error };
}

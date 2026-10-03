type ErrorFormatterArgs = {
  customMessage: string;
  error: unknown;
};

type ErrorWithCode = {
  code?: string;
  message?: string;
};

export function formatErrorMessage(args: ErrorFormatterArgs): string {
  const { customMessage, error } = args;
  let errorMessage: string;

  if (error instanceof Error) {
    const baseMessage = error.message ?? error.toString() ?? 'Unknown error';
    const errorWithCode = error as ErrorWithCode;

    if (errorWithCode.code) {
      errorMessage = `${baseMessage} (Code: ${errorWithCode.code})`;
    } else {
      errorMessage = baseMessage;
    }
  } else if (error && typeof error === 'object' && 'code' in error) {
    const errorObj = error as ErrorWithCode;
    const message = errorObj.message ?? String(error);
    errorMessage = errorObj.code
      ? `${message} (Code: ${errorObj.code})`
      : message;
  } else {
    errorMessage = String(error ?? 'Unknown error');
  }

  return `${customMessage}:\n${errorMessage}`;
}

/**
 * The text of any caught value for a log line, an alert or an errorText: an Error gives its message
 * (its toString when the message is empty), an object with a message gives that, anything else is
 * stringified. THE one helper for this — every app and this library used to carry its own copy of
 * `error instanceof Error ? error.message : String(error)`.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.toString();
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as ErrorWithCode).message;

    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }

  return String(error ?? 'Unknown error');
}

/**
 * The exchange's own words for a refused order — what the caller shows to a person.
 *
 * The log line keeps the context prefix ("Failed to create order:") and the "(Code: N)" suffix,
 * but errorText is not a log line: glued there, the prefix pushed the real reason out of sight and
 * the code was printed twice (AVAUSDT on Bybit 17.09.2026 — "Failed to create order:\nBybit API
 * error 110090: … (Code: 110090)", read as a margin shortage). The code travels in errorCode.
 * The same reading as `describeError`; the name says where it is used.
 */
export function describeExchangeRefusal(error: unknown): string {
  return describeError(error);
}

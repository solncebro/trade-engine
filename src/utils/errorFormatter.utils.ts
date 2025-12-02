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


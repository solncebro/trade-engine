import pino, { Logger, TransportTargetOptions } from 'pino';

export interface CreateLoggerArgs {
  level?: string;
  isConsoleEnabled?: boolean;
  isFileEnabled?: boolean;
  filePath?: string;
  betterStackToken?: string;
  betterStackEndpoint?: string;
}

function buildLogtailIngestUrl(hostnameOrUrl: string): string {
  const trimmedValue = hostnameOrUrl.trim();

  if (
    trimmedValue.startsWith('https://') ||
    trimmedValue.startsWith('http://')
  ) {
    return trimmedValue;
  }

  return `https://${trimmedValue}`;
}

export function createLogger(args?: CreateLoggerArgs): Logger {
  const {
    level = process.env.LOG_LEVEL ?? 'info',
    isConsoleEnabled = true,
    isFileEnabled = false,
    filePath = './logs/output.logs',
    betterStackToken = process.env.BETTERSTACK_TOKEN,
    betterStackEndpoint = process.env.BETTERSTACK_ENDPOINT,
  } = args ?? {};

  const betterStackTokenResolved = betterStackToken?.trim();
  const betterStackEndpointRaw = betterStackEndpoint?.trim();
  const betterStackEndpointResolved = betterStackEndpointRaw
    ? buildLogtailIngestUrl(betterStackEndpointRaw)
    : undefined;

  const transportTargetList: TransportTargetOptions[] = [];

  if (isConsoleEnabled) {
    transportTargetList.push({
      target: 'pino-pretty',
      level: 'info',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    });
  }

  if (isFileEnabled) {
    transportTargetList.push({
      target: 'pino-pretty',
      options: {
        destination: filePath,
        mkdir: true,
        colorize: false,
      },
    });
  }

  if (betterStackTokenResolved && betterStackEndpointResolved) {
    transportTargetList.push({
      target: '@logtail/pino',
      options: {
        sourceToken: betterStackTokenResolved,
        options: { endpoint: betterStackEndpointResolved },
      },
    });
  }

  return pino({
    level,
    serializers: {
      error: pino.stdSerializers.wrapErrorSerializer((error) => ({
        ...error,
        code: (error as Record<string, unknown>).code,
        exchange: (error as Record<string, unknown>).exchange,
      })),
    },
    transport: {
      targets: transportTargetList,
    },
  });
}

let loggerInstance: Logger | null = null;

export const logger = new Proxy({} as Logger, {
  get(_target, property) {
    if (!loggerInstance) {
      loggerInstance = createLogger({
        isConsoleEnabled: true,
        isFileEnabled: true,
      });
    }

    return loggerInstance[property as keyof Logger];
  },
});

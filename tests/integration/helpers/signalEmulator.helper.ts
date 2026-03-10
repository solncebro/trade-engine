import WebSocket, { WebSocketServer } from 'ws';

export interface TestMessage {
  sendTime: number;
  scrapedTime: number;
  sourceTime: number | null;
  source: string;
  title: string;
  id: string;
}

export interface SendSignalArgs {
  source: string;
  title: string;
  id?: string;
}

export class SignalEmulatorServer {
  private server: WebSocketServer | null = null;
  private connectedClientList: WebSocket[] = [];
  private connectionResolveList: Array<() => void> = [];

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = new WebSocketServer({ port: 0 }, () => {
        const address = this.server!.address();

        if (typeof address === 'object' && address !== null) {
          resolve(address.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      this.server.on('connection', (ws: WebSocket) => {
        this.connectedClientList.push(ws);

        ws.on('close', () => {
          this.connectedClientList = this.connectedClientList.filter(
            client => client !== ws
          );
        });

        for (const resolveFn of this.connectionResolveList) {
          resolveFn();
        }

        this.connectionResolveList = [];
      });

      this.server.on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    for (const client of this.connectedClientList) {
      client.close();
    }

    this.connectedClientList = [];

    return new Promise(resolve => {
      if (!this.server) {
        resolve();

        return;
      }

      this.server.close(() => resolve());
    });
  }

  public sendSignal(args: SendSignalArgs): void {
    const now = Date.now();

    const message: TestMessage = {
      sendTime: now,
      scrapedTime: now - 1,
      sourceTime: null,
      source: args.source,
      title: args.title,
      id: args.id ?? `test_${now}`,
    };

    const json = JSON.stringify(message);

    for (const client of this.connectedClientList) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  public waitForConnection(timeoutMs = 5000): Promise<void> {
    if (this.connectedClientList.length > 0) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`No connection within ${timeoutMs}ms`));
      }, timeoutMs);

      this.connectionResolveList.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export const parseSymbolFromSignalTitle = (title: string): string | null => {
  const directMatch = title.match(/([A-Z0-9]+USDT)\b/);

  if (directMatch) {
    return directMatch[1];
  }

  const bracketMatch = title.match(/\(([A-Z0-9]+)\)/);

  if (bracketMatch) {
    return `${bracketMatch[1]}USDT`;
  }

  return null;
};

export const waitForMessage = (
  client: WebSocket,
  timeoutMs = 5000
): Promise<TestMessage> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`No message received within ${timeoutMs}ms`));
    }, timeoutMs);

    client.once('message', (data: WebSocket.Data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as TestMessage);
    });
  });

export const connectClient = (
  port: number,
  timeoutMs = 5000
): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://localhost:${port}`);

    const timer = setTimeout(() => {
      client.close();
      reject(new Error(`Client did not connect within ${timeoutMs}ms`));
    }, timeoutMs);

    client.once('open', () => {
      clearTimeout(timer);
      resolve(client);
    });

    client.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });

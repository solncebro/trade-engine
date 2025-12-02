import * as readline from 'readline';

import dotenv from 'dotenv';
import WebSocket from 'ws';

import { logger } from '../core/logger';

dotenv.config();

interface TestMessage {
  sendTime: number;
  scrapedTime: number;
  sourceTime: number | null;
  source: string;
  title: string;
  id: string;
}

class WebSocketEmulator {
  private server: WebSocket.Server;
  private readlineInterface: readline.Interface;
  private connectedClientList: WebSocket[] = [];
  private port: number;
  private host: string;

  constructor() {
    const websocketUrl = 'ws://localhost:8765';
    const urlParts = new URL(websocketUrl);

    this.host = urlParts.hostname;
    this.port =
      parseInt(urlParts.port) || (urlParts.protocol === 'wss:' ? 443 : 8765);

    console.log({ host: this.host, port: this.port, websocketUrl });

    this.server = new WebSocket.Server({ port: this.port, host: this.host });
    this.readlineInterface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  private setupServerHandlers(): void {
    this.server.on('connection', (websocket: WebSocket) => {
      logger.info('Client connected to WebSocket emulator');
      this.connectedClientList.push(websocket);

      websocket.on('close', () => {
        logger.info('Client disconnected from WebSocket emulator');
        this.connectedClientList = this.connectedClientList.filter(
          client => client !== websocket
        );
      });

      websocket.on('error', error => {
        logger.error({ error }, 'WebSocket client error');
      });
    });

    this.server.on('error', error => {
      logger.error({ error }, 'WebSocket server error');
    });
  }

  private async sendTestMessage(message: TestMessage): Promise<void> {
    const messageJson = JSON.stringify(message);

    logger.info(
      { message, clientCount: this.connectedClientList.length },
      'Broadcasting test message'
    );

    this.connectedClientList.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageJson);
      }
    });
  }

  private getPresetMessageList(): TestMessage[] {
    const now = Date.now();

    return [
      {
        sendTime: now,
        scrapedTime: now - 1,
        sourceTime: null,
        source: 'BINANCE',
        title:
          'Binance Futures Will Launch USDⓈ-Margined API3USDT Perpetual Contract',
        id: 'test_api3_listing',
      },
      {
        sendTime: now,
        scrapedTime: now - 1,
        sourceTime: null,
        source: 'BYBIT',
        title:
          '[BYBIT] New Listing: Sapien (SAPIEN) Will Be Available on Bybit',
        id: 'test_sapien_listing',
      },
      {
        sendTime: now,
        scrapedTime: now - 1,
        sourceTime: null,
        source: 'BINANCE',
        title:
          'Binance Will Delist SOLUSDT Perpetual Contract (Delisting Notice)',
        id: 'test_sol_delisting',
      },
      {
        sendTime: now,
        scrapedTime: now - 1,
        sourceTime: null,
        source: 'UPBIT',
        title:
          '[UPBIT LISTING] 에이피아이쓰리(API3) KRW, USDT 마켓 디지털 자산 추가',
        id: 'test_upbit_api3',
      },
    ];
  }

  private async showMenu(): Promise<void> {
    console.log('\n=== WebSocket Signal Emulator ===');
    console.log('1. Send API3 listing signal');
    console.log('2. Send SAPIEN listing signal');
    console.log('3. Send SOL delisting signal');
    console.log('4. Send UPBIT API3 listing signal');
    console.log('5. Send custom message');
    console.log('6. Show connected clients');
    console.log('7. Exit');
    console.log(`\nServer running on ${this.host}:${this.port}`);
    console.log(`Connected clients: ${this.connectedClientList.length}`);
  }

  private async handleCustomMessage(): Promise<void> {
    const source = await this.askQuestion('Enter source (e.g., BINANCE): ');
    const title = await this.askQuestion('Enter title: ');
    const id =
      (await this.askQuestion('Enter ID (optional): ')) ||
      `custom_${Date.now()}`;

    const now = Date.now();
    const customMessage: TestMessage = {
      sendTime: now,
      scrapedTime: now - 1,
      sourceTime: null,
      source: source.toUpperCase(),
      title,
      id,
    };

    await this.sendTestMessage(customMessage);
  }

  private async askQuestion(question: string): Promise<string> {
    return new Promise(resolve => {
      this.readlineInterface.question(question, answer => {
        resolve(answer.trim());
      });
    });
  }

  public async start(): Promise<void> {
    try {
      this.setupServerHandlers();

      logger.info(
        { host: this.host, port: this.port },
        'WebSocket emulator server started'
      );
      console.log(
        `\nWebSocket emulator started on ws://${this.host}:${this.port}`
      );
      console.log('Waiting for client connections...\n');

      await this.runInteractiveMenu();
    } catch (error) {
      logger.error({ error }, 'Failed to start WebSocket emulator');
      throw error;
    } finally {
      this.readlineInterface.close();
      this.server.close();
    }
  }

  private async runInteractiveMenu(): Promise<void> {
    const presetMessageList = this.getPresetMessageList();

    while (true) {
      await this.showMenu();
      const choice = await this.askQuestion('\nEnter your choice (1-7): ');

      switch (choice) {
        case '1':
          await this.sendTestMessage(presetMessageList[0]);
          break;
        case '2':
          await this.sendTestMessage(presetMessageList[1]);
          break;
        case '3':
          await this.sendTestMessage(presetMessageList[2]);
          break;
        case '4':
          await this.sendTestMessage(presetMessageList[3]);
          break;
        case '5':
          await this.handleCustomMessage();
          break;
        case '6':
          console.log(
            `\nConnected clients: ${this.connectedClientList.length}`
          );
          break;
        case '7':
          console.log('Shutting down emulator...');

          return;
        default:
          console.log('Invalid choice. Please try again.');
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

const emulator = new WebSocketEmulator();
emulator.start().catch(console.error);

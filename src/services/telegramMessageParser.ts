import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { Api } from 'telegram';

import { WebSocketMessage } from '../types/websocket';

dayjs.extend(utc);

export class TelegramMessageParser {
  public parseMessage(message: Api.Message): WebSocketMessage | null {
    const messageText = message.message;

    if (!messageText || messageText.trim().length === 0) {
      return null;
    }

    const pattern = /^\[([^\]]+)\]\s+(.+?)\n(.+)$/;
    const match = messageText.match(pattern);

    if (!match) {
      return null;
    }

    const [, source, title, timeString] = match;
    const timestamp = this.parseTimestamp(timeString);

    if (!timestamp) {
      return null;
    }

    return {
      id: message.id.toString(),
      title,
      source,
      sendTime: timestamp,
      scrapedTime: timestamp,
      sourceTime: null,
    };
  }

  private parseTimestamp(timeString: string): number | null {
    const timePattern = /^(\d{2}):(\d{2}):(\d{2})-(\d{3})(?:\s+\+\d+)?$/;
    const match = timeString.trim().match(timePattern);

    if (!match) {
      return null;
    }

    const [, hours, minutes, seconds, milliseconds] = match;
    const utcDate = dayjs
      .utc()
      .hour(parseInt(hours, 10))
      .minute(parseInt(minutes, 10))
      .second(parseInt(seconds, 10))
      .millisecond(parseInt(milliseconds, 10));

    return utcDate.valueOf();
  }
}

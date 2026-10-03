import type { BalanceUpdateEvent, OrderUpdateEvent, PositionUpdateEvent } from '@solncebro/exchange-engine';

import type { UserDataStreamClient, UserDataStreamRouterArgs, UserDataStreamSubscriber, UserDataStreamUnsubscribe } from './userDataStreamRouter.types';

import { logger } from '../core/logger';

type SubscriberCallbackName = Exclude<keyof UserDataStreamSubscriber, 'name'>;

/**
 * One private (user-data) stream per exchange client, fanned out to any number of subscribers —
 * OrderManager.handleOrderUpdate, PositionMonitor.handleOrderUpdate, the app's own handlers. The
 * exchange layer takes ONE handler set per client: a second connectUserDataStream call would replace
 * the first consumer's handlers or open a second socket, so every consumer goes through this router.
 *
 * Each subscriber is isolated: a throw or a rejected promise is logged with its name and the next
 * subscriber still gets the event (the stream's own guard only catches synchronous throws, and a
 * rejected handler promise would otherwise vanish — rubber's rubber.ts:983). On a drop every subscriber
 * hears onConnectionLost; on the return onConnectionRestored and then onResyncRequired, because the
 * events of the gap are gone for good (rubber TradeEngine.handleOrderStreamLost / Restored).
 */
class UserDataStreamRouter {
  private readonly client: UserDataStreamClient;
  private readonly label: string;
  private readonly subscriberList: UserDataStreamSubscriber[] = [];
  private connectPromise: Promise<void> | null = null;
  private isConnectedFlag = false;
  private isConnectionLostFlag = false;

  constructor(args: UserDataStreamRouterArgs) {
    this.client = args.client;
    this.label = args.label;
  }

  /** Adds a subscriber (before or after connect); returns its unsubscribe. */
  subscribe(subscriber: UserDataStreamSubscriber): UserDataStreamUnsubscribe {
    this.subscriberList.push(subscriber);

    return () => {
      const index = this.subscriberList.indexOf(subscriber);

      if (index !== -1) {
        this.subscriberList.splice(index, 1);
      }
    };
  }

  /**
   * Opens the stream once; concurrent and repeated calls share that one connection. A failed connect
   * rejects and leaves the router ready for another attempt.
   */
  async connect(): Promise<void> {
    if (this.connectPromise !== null) {
      return this.connectPromise;
    }

    const connectPromise = this.client.connectUserDataStream({
      onOrderUpdate: event => this.dispatch('onOrderUpdate', event),
      onPositionUpdate: event => this.dispatch('onPositionUpdate', event),
      onBalanceUpdate: event => this.dispatch('onBalanceUpdate', event),
      onConnectionLost: () => this.handleConnectionLost(),
      onConnectionRestored: () => this.handleConnectionRestored(),
    });

    this.connectPromise = connectPromise;

    try {
      await connectPromise;
      this.isConnectedFlag = true;
      logger.info({ label: this.label, subscriberCount: this.subscriberList.length }, `[UserDataStreamRouter] ${this.label} user data stream connected`);
    } catch (error: unknown) {
      this.connectPromise = null;
      logger.error({ error, label: this.label }, `[UserDataStreamRouter] ${this.label} user data stream connect failed`);

      throw error;
    }
  }

  disconnect(): void {
    if (this.connectPromise === null) {
      return;
    }

    this.client.disconnectUserDataStream();
    this.connectPromise = null;
    this.isConnectedFlag = false;
    this.isConnectionLostFlag = false;
  }

  /** Connected and not in a reported drop. */
  isLive(): boolean {
    return this.isConnectedFlag && !this.isConnectionLostFlag;
  }

  getSubscriberCount(): number {
    return this.subscriberList.length;
  }

  private handleConnectionLost(): void {
    this.isConnectionLostFlag = true;
    logger.warn({ label: this.label }, `[UserDataStreamRouter] ${this.label} user data stream lost — events until it returns are missed`);
    this.dispatch('onConnectionLost');
  }

  private handleConnectionRestored(): void {
    this.isConnectionLostFlag = false;
    logger.info({ label: this.label }, `[UserDataStreamRouter] ${this.label} user data stream restored — subscribers re-read their state`);
    this.dispatch('onConnectionRestored');
    this.dispatch('onResyncRequired');
  }

  private dispatch(callbackName: 'onOrderUpdate', event: OrderUpdateEvent): void;
  private dispatch(callbackName: 'onPositionUpdate', event: PositionUpdateEvent): void;
  private dispatch(callbackName: 'onBalanceUpdate', event: BalanceUpdateEvent): void;
  private dispatch(callbackName: 'onConnectionLost' | 'onConnectionRestored' | 'onResyncRequired'): void;
  private dispatch(callbackName: SubscriberCallbackName, event?: OrderUpdateEvent | PositionUpdateEvent | BalanceUpdateEvent): void {
    // A snapshot: a subscriber that unsubscribes inside its own handler must not make the loop skip the next one.
    for (const subscriber of [...this.subscriberList]) {
      const callback = subscriber[callbackName] as ((payload?: unknown) => void | Promise<void>) | undefined;

      if (callback === undefined) {
        continue;
      }

      const reportFailure = (error: unknown): void => {
        logger.error(
          { error, label: this.label, subscriber: subscriber.name, callbackName, symbol: (event as { symbol?: string } | undefined)?.symbol },
          `[UserDataStreamRouter] ${this.label} subscriber "${subscriber.name}" ${callbackName} failed — other subscribers unaffected`
        );
      };

      try {
        const result = callback.call(subscriber, event);

        if (result instanceof Promise) {
          result.catch(reportFailure);
        }
      } catch (error: unknown) {
        reportFailure(error);
      }
    }
  }
}

export { UserDataStreamRouter };

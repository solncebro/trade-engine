import type { BalanceUpdateEvent, ExchangeClient, OrderUpdateEvent, PositionUpdateEvent } from '@solncebro/exchange-engine';

/** The part of an exchange client the router drives (`connector.futures` / `connector.spot`). */
type UserDataStreamClient = Pick<ExchangeClient, 'connectUserDataStream' | 'disconnectUserDataStream'>;

type MaybePromise = void | Promise<void>;

/** One consumer of the private stream. Every callback is optional; a throw or a rejection stays with its subscriber. */
interface UserDataStreamSubscriber {
  /** For the logs: whose handler failed. */
  name: string;
  onOrderUpdate?: (event: OrderUpdateEvent) => MaybePromise;
  onPositionUpdate?: (event: PositionUpdateEvent) => MaybePromise;
  onBalanceUpdate?: (event: BalanceUpdateEvent) => MaybePromise;
  /** The stream dropped: events from now until the return are lost. */
  onConnectionLost?: () => MaybePromise;
  /** The stream is back. */
  onConnectionRestored?: () => MaybePromise;
  /** Called right after onConnectionRestored: re-read open orders / positions — the gap's events are gone for good. */
  onResyncRequired?: () => MaybePromise;
}

interface UserDataStreamRouterArgs {
  client: UserDataStreamClient;
  /** Log label, e.g. "Bybit Futures sub-1". */
  label: string;
}

type UserDataStreamUnsubscribe = () => void;

export type {
  UserDataStreamClient,
  UserDataStreamRouterArgs,
  UserDataStreamSubscriber,
  UserDataStreamUnsubscribe,
};

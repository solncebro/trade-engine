# @solncebro/trade-engine

Universal trading engine library for cryptocurrency exchanges with Telegram integration and Firebase support.

## Installation

```bash
npm install @solncebro/trade-engine
```

## Usage

### ExchangeConnector

Connect to an exchange via CCXT:

```typescript
import { ExchangeConnector } from '@solncebro/trade-engine';

const connector = new ExchangeConnector({
  exchangeId: 'bybit',
  apiKey: process.env.API_KEY!,
  secret: process.env.API_SECRET!,
});

await connector.init();
const ticker = await connector.fetchTicker('BTC/USDT');
```

### OrderExecutor

Execute orders with built-in error handling:

```typescript
import { OrderExecutor, OrderCalculator, ExchangeConnector } from '@solncebro/trade-engine';

const connector = new ExchangeConnector({ /* ... */ });
await connector.init();

const calculator = new OrderCalculator(connector);
const executor = new OrderExecutor(connector);

const result = await executor.executeMarketOrder({
  symbol: 'BTC/USDT',
  side: 'buy',
  amount: 0.001,
});
```

## License

[MIT](LICENSE)

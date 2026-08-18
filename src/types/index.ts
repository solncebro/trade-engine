export {
  ExchangeNameEnum,
  MARKET_TYPE_LIST,
  MarginModeEnum,
  MarketTypeEnum,
  MarketUnitEnum,
  OrderFilterEnum,
  OrderSideEnum,
  OrderTypeEnum,
  PositionModeEnum,
  PositionSideEnum,
  TimeInForceEnum,
  TradeSymbolTypeEnum,
  TriggerByEnum,
  WebSocketConnectionTypeEnum,
  WorkingTypeEnum,
} from '@solncebro/exchange-engine';
// Все ТИПЫ нижней библиотеки отдаются сквозняком, без поимённого перечня. Перечень эту работу не
// выполнял, а лишь догонял: дыру латали восемью выпусками за пять месяцев (3.3.0 → 3.3.1 в один
// день, `TriggerByEnum` дважды — второй раз уже после боевого инцидента). Теперь новый тип нижней
// библиотеки виден потребителю сам, и забыть его нельзя; сторож-тест это проверяет.
//
// Именно `export type *`, а не `export *`: значения так не проходят, поэтому класс `Exchange`
// остаётся доступен ТОЛЬКО как тип — принцип единой двери (всё к бирже через ExchangeConnector)
// сохраняется. Значения, которые потребителю нужны по-настоящему, перечислены выше явно.
export type * from '@solncebro/exchange-engine';

export * from './common';
export * from './exchange';
export * from './firebase';
export * from './orders';
export * from './priceLimit';
export * from './telegram';
export * from './telegramCommandHandler';
export * from './strategy';

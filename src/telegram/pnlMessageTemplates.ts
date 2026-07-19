import { formatClickableText } from '@solncebro/telegram-engine';

import { formatDirection, formatMaLevel, formatTimeframe } from './pnlMessageFormatHelpers';
import type { AutoCloseCancelledMessageArgs, AutoCloseMessageArgs, AutoTpMenuMessageArgs, EphemeralPositionDetailMessageArgs, ExternalMultiEntryCancelMessageArgs, HalfClosedMessageArgs, InsuranceAdditionalFillMessageArgs, InsuranceFilledMessageArgs, LossAlertMessageArgs, PendingEntriesCancelledMessageArgs, PositionAugmentedMessageArgs, PositionClosedMessageArgs, PositionDetailMessageArgs, PositionRemovedExternallyMessageArgs, PositionsListMessageArgs, ProfitAlertMessageArgs, SosCancelledMessageArgs, SosMarkedMessageArgs, StopLossStatus, TpCancelledMessageArgs, TpSplitConfirmationArgs, TpSplitCreatedMessageArgs } from './pnlMessageTemplates.types';

import type { MaLevel } from '../types/index';
import { EMOJI_CHECK, EMOJI_CROSS, EMOJI_INFO, EMOJI_PAUSE, EMOJI_PROFIT, EMOJI_ROBOT, EMOJI_SCISSORS, EMOJI_SOS, EMOJI_WARNING } from '../utils/emoji';

const ORDER_ID_SHORT_THRESHOLD = 15;

function formatOrderIdShort(orderId: string | null | undefined): string {
  if (!orderId) {
    return 'none';
  }

  if (orderId.length <= ORDER_ID_SHORT_THRESHOLD) {
    return orderId;
  }

  return `${orderId.slice(0, 6)}...${orderId.slice(-6)}`;
}

function formatStopLossBlock(stopLossLevel: number, stopLossStatus: StopLossStatus | undefined, stopLossOrderId: string | null | undefined, errorText: string | null | undefined): string[] {
  const statusLabel = stopLossStatus ?? 'active';
  const lineList = [
    `Stop-loss level: ${stopLossLevel.toFixed(2)}%`,
    `SL status: ${statusLabel}`,
    `SL order: ${formatOrderIdShort(stopLossOrderId)}`,
  ];

  if (statusLabel === 'missing' && errorText) {
    lineList.push(`SL error: ${errorText}`);
  }

  return lineList;
}

function buildHeaderTail(maLevel: MaLevel, isAugmented: boolean, tail: string): string {
  if (isAugmented) {
    return tail;
  }

  return `${formatMaLevel(maLevel)} — ${tail}`;
}

function buildPnlMessage(iconLine: string, tailLine: string, bodyLineList: ReadonlyArray<string>): string {
  return [iconLine, tailLine, ...bodyLineList].join('\n');
}

function formatProfitAlertMessage(args: ProfitAlertMessageArgs): string {
  const { symbol, timeframe, direction, pnlPercent, entryPrice, lastPrice, maLevel, isAugmented, stopLossLevel, stopLossStatus, stopLossOrderId, stopLossErrorText } = args;

  return buildPnlMessage(
    `🟢 ${formatTimeframe(timeframe)} \`${symbol}\` ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, `PNL +${pnlPercent.toFixed(1)}%`),
    [
      `Entry: \`${entryPrice}\` → Last: \`${lastPrice}\``,
      ...formatStopLossBlock(stopLossLevel, stopLossStatus, stopLossOrderId, stopLossErrorText),
    ],
  );
}

function formatLossAlertMessage(args: LossAlertMessageArgs): string {
  const { symbol, timeframe, direction, pnlPercent, entryPrice, lastPrice, maLevel, isAugmented } = args;
  const bodyLineList: string[] = [`Entry: \`${entryPrice}\` → Last: \`${lastPrice}\``];

  if (args.isInsuranceCreated && args.insuranceMaLevel) {
    bodyLineList.push(`⚡ Insurance chaser created on ${formatMaLevel(args.insuranceMaLevel)}`);
  } else if (args.isInsuranceLinked && args.insuranceMaLevel) {
    bodyLineList.push(`🔗 Linked existing chaser on ${formatMaLevel(args.insuranceMaLevel)} as insurance`);
  } else if (args.insuranceFailReason) {
    bodyLineList.push(`❌ Insurance not created: ${args.insuranceFailReason}`);
  }

  return buildPnlMessage(
    `🔴 ${formatTimeframe(timeframe)} \`${symbol}\` ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, `PNL ${pnlPercent.toFixed(1)}%`),
    bodyLineList,
  );
}

function formatAutoCloseMessage(args: AutoCloseMessageArgs): string {
  const { symbol, timeframe, direction, pnlPercent, entryPrice, lastPrice, maLevel, isAugmented } = args;

  return buildPnlMessage(
    `🔒 ${formatTimeframe(timeframe)} \`${symbol}\` ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, `Auto-closed @ PNL +${pnlPercent.toFixed(1)}%`),
    [`Entry: \`${entryPrice}\` → Close: \`${lastPrice}\``],
  );
}

function formatPositionClosedMessage(args: PositionClosedMessageArgs): string {
  const { symbol, timeframe, direction, maLevel, entryPrice, isAugmented } = args;
  const bodyLineList: string[] = [];

  if (isAugmented) {
    bodyLineList.push(`Entry: \`${entryPrice}\``);
  }

  return buildPnlMessage(
    `✅ ${formatTimeframe(timeframe)} ${formatClickableText(symbol)} ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, 'Position closed'),
    bodyLineList,
  );
}

function formatAutoCloseCancelledMessage(args: AutoCloseCancelledMessageArgs): string {
  const { symbol, timeframe, direction, maLevel, thresholdPercent, entryPrice, isAugmented } = args;
  const bodyLineList: string[] = [];

  if (isAugmented) {
    bodyLineList.push(`Entry: \`${entryPrice}\``);
  }

  return buildPnlMessage(
    `ℹ️ ${formatTimeframe(timeframe)} ${formatClickableText(symbol)} ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, `Auto-close +${thresholdPercent}% reached, cancelled — user acknowledged`),
    bodyLineList,
  );
}

function buildMonitoringStatusLine(isTrailingSlEnabled: boolean, isPnlAlertsEnabled: boolean, isAutoCloseEnabled: boolean): string | null {
  const offLabelList: string[] = [];

  if (!isTrailingSlEnabled) {
    offLabelList.push('trailing-sl');
  }

  if (!isPnlAlertsEnabled) {
    offLabelList.push('alerts');
  }

  if (!isAutoCloseEnabled) {
    offLabelList.push('auto-close');
  }

  if (offLabelList.length === 0) {
    return null;
  }

  return `${EMOJI_PAUSE} Off: ${offLabelList.join(', ')}`;
}

function formatFilledLine(plannedNotionalUsdt: number, actualNotionalUsdt: number): string | null {
  if (!Number.isFinite(plannedNotionalUsdt) || plannedNotionalUsdt <= 0) {
    return null;
  }

  const safeActual = Number.isFinite(actualNotionalUsdt) ? Math.max(0, actualNotionalUsdt) : 0;
  const filledPercent = safeActual / plannedNotionalUsdt * 100;

  return `Filled: $${safeActual.toFixed(0)} / $${plannedNotionalUsdt.toFixed(0)} (${filledPercent.toFixed(0)}%)`;
}

function formatPositionsListMessage(args: PositionsListMessageArgs): string {
  const { exchangeLabel, trackedList, ephemeralList } = args;

  if (trackedList.length === 0 && ephemeralList.length === 0) {
    return `💠 No active positions on ${exchangeLabel}`;
  }

  const lineList: string[] = [];

  if (trackedList.length > 0) {
    lineList.push(`💠 Chaser positions on ${exchangeLabel} (${trackedList.length}):`, '');

    for (const position of trackedList) {
      const dirIcon = position.direction === 'long' ? '🟢' : '🔴';
      const dirLabel = formatDirection(position.direction);
      const pnlSign = position.pnlPercent >= 0 ? '+' : '';
      const liqSign = position.liquidationDistancePercent >= 0 ? '+' : '';

      const actualNotionalUsdt = position.contracts * position.entryPrice;
      const pnlUsdt = actualNotionalUsdt * position.pnlPercent / 100;
      const filledLine = formatFilledLine(position.plannedNotionalUsdt, actualNotionalUsdt);
      const importedSuffix = position.isImported ? ' [imp]' : '';

      lineList.push(
        `${dirIcon} \`${position.symbol}\`${importedSuffix} ${dirLabel}`,
        `  Entry: \`${position.entryPrice}\` | BE: \`${position.breakevenPrice}\``,
        `  Volume: ${position.volumeUsdt} USDT × ${position.leverage}x`,
      );

      if (filledLine !== null) {
        lineList.push(`  ${filledLine}`);
      }

      lineList.push(
        `  PNL: ${pnlSign}${position.pnlPercent.toFixed(1)}% (${pnlSign}${pnlUsdt.toFixed(1)} USDT)`,
        `  Liq: \`${position.liquidationPrice}\` (${liqSign}${position.liquidationDistancePercent.toFixed(1)}%)`,
      );

      if (position.isHalveMarkActive) {
        lineList.push(`  ${EMOJI_SOS} SOS marked — halve at +${position.breakevenHalfClosePercent}% pending`);
      }

      if (position.hasInsurance && position.insuranceMaLevel) {
        lineList.push(`  ${EMOJI_SOS} Insurance on ${formatMaLevel(position.insuranceMaLevel)}`);
      } else if (position.isInsuranceMissing) {
        lineList.push(`  ${EMOJI_SOS} Insurance (missing — chaser not found)`);
      }

      const statusLine = buildMonitoringStatusLine(position.isTrailingSlEnabled, position.isPnlAlertsEnabled, position.isAutoCloseEnabled);

      if (statusLine !== null) {
        lineList.push(`  ${statusLine}`);
      }

      lineList.push('');
    }
  }

  if (ephemeralList.length > 0) {
    lineList.push(`🌐 Imported on exchange (${ephemeralList.length}):`, '');

    for (const ephemeral of ephemeralList) {
      const dirIcon = ephemeral.direction === 'long' ? '🟢' : '🔴';
      const dirLabel = formatDirection(ephemeral.direction);
      const pnlSign = ephemeral.pnlPercent >= 0 ? '+' : '';
      const actualNotionalUsdt = ephemeral.contracts * ephemeral.entryPrice;
      const pnlUsdt = actualNotionalUsdt * ephemeral.pnlPercent / 100;

      lineList.push(
        `${dirIcon} \`${ephemeral.symbol}\` ${dirLabel}`,
        `  Entry: \`${ephemeral.entryPrice}\` · Last: \`${ephemeral.markPrice}\``,
        `  Contracts: ${ephemeral.contracts} × ${ephemeral.leverage}x`,
        `  PNL: ${pnlSign}${ephemeral.pnlPercent.toFixed(1)}% (${pnlSign}${pnlUsdt.toFixed(1)} USDT)`,
        `  Liq: \`${ephemeral.liquidationPrice}\``,
        '',
      );
    }
  }

  return lineList.join('\n').trimEnd();
}

function formatPositionDetailMessage(args: PositionDetailMessageArgs): string {
  const dirIcon = args.direction === 'long' ? '🟢' : '🔴';
  const dirLabel = formatDirection(args.direction);
  const pnlSign = args.pnlPercent >= 0 ? '+' : '';
  const liqSign = args.liquidationDistancePercent >= 0 ? '+' : '';
  const hideMaPrefix = args.isAugmented || args.isImported;
  const headerTail = hideMaPrefix ? '' : ` ${formatMaLevel(args.maLevel)}`;
  const importedSuffix = args.isImported ? ' 📥 Imported' : '';

  const actualNotionalUsdt = args.contracts * args.entryPrice;
  const filledLine = formatFilledLine(args.plannedNotionalUsdt, actualNotionalUsdt);

  const lineList: string[] = [
    `${dirIcon} ${formatTimeframe(args.timeframe)} \`${args.symbol}\` ${dirLabel}${headerTail}${importedSuffix}`,
    '',
    `Entry: \`${args.entryPrice}\` | BE: \`${args.breakevenPrice}\``,
    `Last: \`${args.lastPrice}\``,
    `Volume: ${args.volumeUsdt} USDT × ${args.leverage}x`,
  ];

  if (filledLine !== null) {
    lineList.push(filledLine);
  }

  lineList.push(
    `Contracts: ${args.contracts}`,
    `PNL: ${pnlSign}${args.pnlPercent.toFixed(1)}% (${pnlSign}${args.pnlUsdt.toFixed(1)} USDT)`,
    `Liq: \`${args.liquidationPrice}\` (${liqSign}${args.liquidationDistancePercent.toFixed(1)}%)`,
  );

  if (!args.isImported) {
    lineList.push('', `╔═ MA on ${formatTimeframe(args.timeframe)} ═╗`);

    for (const ma of args.maValueList) {
      const offsetSign = ma.offsetFromLastPercent >= 0 ? '+' : '';

      lineList.push(`${formatMaLevel(ma.level)}: \`${ma.price}\` (${offsetSign}${ma.offsetFromLastPercent.toFixed(2)}% from last)`);
    }
  }

  if (args.isHalveMarkActive) {
    lineList.push('', `${EMOJI_SOS} SOS marked — halve at +${args.breakevenHalfClosePercent}% pending`);
  }

  if (args.hasInsurance && args.insuranceMaLevel !== null) {
    lineList.push('', `${EMOJI_SOS} Insurance on ${formatMaLevel(args.insuranceMaLevel)}`);
  } else if (args.isInsuranceMissing) {
    lineList.push('', `${EMOJI_SOS} Insurance (missing — chaser not found)`);
  }

  const statusLine = buildMonitoringStatusLine(args.isTrailingSlEnabled, args.isPnlAlertsEnabled, args.isAutoCloseEnabled);

  if (statusLine !== null) {
    lineList.push('', statusLine);
  }

  return lineList.join('\n');
}

function formatEphemeralPositionDetailMessage(args: EphemeralPositionDetailMessageArgs): string {
  const dirLabel = formatDirection(args.direction);
  const pnlSign = args.pnlPercent >= 0 ? '+' : '';

  const lineList: string[] = [
    `🌐 \`${args.symbol}\` ${dirLabel} — Imported`,
    '',
    `Entry: \`${args.entryPrice}\``,
    `Last: \`${args.lastPrice}\``,
    `PNL: ${pnlSign}${args.pnlPercent.toFixed(2)}% (${pnlSign}${args.pnlUsdt.toFixed(2)} USDT)`,
    `Contracts: ${args.contracts} · Leverage: ${args.leverage}x`,
    `Liq: \`${args.liquidationPrice}\``,
    '',
    'Not tracked. Tap Track to enable trailing SL / alerts / SOS / cleanup-on-close.',
  ];

  return lineList.join('\n');
}

function formatTpSplitConfirmation(args: TpSplitConfirmationArgs): string {
  const { symbol, direction, maLevel, parts, totalContracts, entryPrice, partList, tpSizeDisplay } = args;
  const lineList = [
    `${EMOJI_PROFIT} TP — ${formatClickableText(symbol)} ${formatDirection(direction)}`,
    `${formatMaLevel(maLevel)} — ${parts} parts`,
    `Total: ${totalContracts} contracts @ entry \`${entryPrice}\``,
  ];

  if (tpSizeDisplay !== undefined) {
    const totalActual = parts * tpSizeDisplay.actualTpSize;
    const sizeLine = tpSizeDisplay.actualTpSize === tpSizeDisplay.requestedTpSize
      ? `TP size: ${parts} × $${tpSizeDisplay.actualTpSize} = $${totalActual}`
      : `TP size: ${parts} × $${tpSizeDisplay.actualTpSize} = $${totalActual} (you requested $${tpSizeDisplay.requestedTpSize})`;
    lineList.push(sizeLine);
  }

  lineList.push('');

  for (let i = 0; i < partList.length; i++) {
    const part = partList[i];

    lineList.push(`${i + 1}. \`${part.price}\` — ${part.amount}`);
  }

  return lineList.join('\n');
}

function formatTpSplitCreatedMessage(args: TpSplitCreatedMessageArgs): string {
  const { symbol, direction, parts, firstPrice, lastPrice } = args;

  return buildPnlMessage(
    `${EMOJI_CHECK} TP created — ${formatClickableText(symbol)} ${formatDirection(direction)}`,
    `${parts} orders placed between \`${firstPrice}\` and \`${lastPrice}\``,
    [],
  );
}

function formatInsuranceFilledMessage(args: InsuranceFilledMessageArgs): string {
  const { symbol, timeframe, direction, maLevel, entryPrice, breakevenPrice, lastPrice, pnlPercent, contracts, breakevenHalfClosePercent, profitThresholdPercent, profitAutoClosePercent } = args;
  const pnlSign = pnlPercent >= 0 ? '+' : '';
  const autoCloseLabel = profitAutoClosePercent === 0 ? 'OFF' : `+${profitAutoClosePercent}%`;

  return buildPnlMessage(
    `${EMOJI_SOS} ${formatTimeframe(timeframe)} \`${symbol}\` ${formatDirection(direction)}`,
    `${formatMaLevel(maLevel)} — Insurance filled, mode switched`,
    [
      '',
      `Entry averaged: \`${entryPrice}\``,
      `Breakeven price: \`${breakevenPrice}\``,
      `Last: \`${lastPrice}\` · PNL: ${pnlSign}${pnlPercent.toFixed(2)}%`,
      `Contracts: ${contracts}`,
      '',
      `Breakeven half-close at +${breakevenHalfClosePercent}%`,
      `Profit pipeline resumed (step +${profitThresholdPercent}% / auto-close ${autoCloseLabel})`,
    ],
  );
}

function formatInsuranceAdditionalFillMessage(args: InsuranceAdditionalFillMessageArgs): string {
  const { symbol, timeframe, direction, maLevel, previousEntryPrice, entryPrice, previousBreakevenPrice, breakevenPrice, lastPrice, pnlPercent, contracts, breakevenHalfClosePercent } = args;
  const pnlSign = pnlPercent >= 0 ? '+' : '';

  return buildPnlMessage(
    `${EMOJI_SOS} ${formatTimeframe(timeframe)} \`${symbol}\` ${formatDirection(direction)}`,
    `${formatMaLevel(maLevel)} — Additional insurance fill, entry re-averaged`,
    [
      '',
      `Entry: \`${previousEntryPrice}\` → \`${entryPrice}\``,
      `Breakeven: \`${previousBreakevenPrice}\` → \`${breakevenPrice}\``,
      `Last: \`${lastPrice}\` · PNL: ${pnlSign}${pnlPercent.toFixed(2)}%`,
      `Contracts: ${contracts}`,
      '',
      `Breakeven half-close at +${breakevenHalfClosePercent}%`,
    ],
  );
}

function formatSosMarkedMessage(args: SosMarkedMessageArgs): string {
  const { symbol, timeframe, direction, maLevel, entryPrice, breakevenPrice, lastPrice, pnlPercent, contracts, breakevenHalfClosePercent, isAugmented } = args;
  const pnlSign = pnlPercent >= 0 ? '+' : '';

  return buildPnlMessage(
    `${EMOJI_SOS} ${formatTimeframe(timeframe)} \`${symbol}\` ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, 'Marked as SOS by user'),
    [
      '',
      `Entry: \`${entryPrice}\``,
      `Breakeven price: \`${breakevenPrice}\``,
      `Last: \`${lastPrice}\` · PNL: ${pnlSign}${pnlPercent.toFixed(2)}%`,
      `Contracts: ${contracts}`,
      '',
      `Breakeven half-close at +${breakevenHalfClosePercent}%`,
    ],
  );
}

function formatPositionAugmentedMessage(args: PositionAugmentedMessageArgs): string {
  const { symbol, timeframe, direction, previousEntryPrice, entryPrice, previousContracts, contracts, lastPrice, pnlPercent, liquidationPrice } = args;
  const dirIcon = direction === 'long' ? '🟢' : '🔴';
  const pnlSign = pnlPercent >= 0 ? '+' : '';
  const previousContractsLabel = previousContracts.toLocaleString('en-US');
  const contractsLabel = contracts.toLocaleString('en-US');

  return buildPnlMessage(
    `${dirIcon} ${formatTimeframe(timeframe)} \`${symbol}\` ${formatDirection(direction)}`,
    'Position augmented (new chaser merged)',
    [
      '',
      `Entry: \`${previousEntryPrice}\` → \`${entryPrice}\``,
      `Contracts: ${previousContractsLabel} → ${contractsLabel}`,
      `Last: \`${lastPrice}\` · PNL: ${pnlSign}${pnlPercent.toFixed(2)}%`,
      `Liq: \`${liquidationPrice}\``,
    ],
  );
}

function formatSosCancelledMessage(args: SosCancelledMessageArgs): string {
  const { symbol, timeframe, direction, maLevel, isAugmented, cancelledInsuranceMaLevel } = args;
  const bodyLineList: string[] = ['', 'Halve-at-breakeven disabled. Position returned to normal monitoring.'];

  if (cancelledInsuranceMaLevel !== null) {
    bodyLineList.push(`Insurance order on ${formatMaLevel(cancelledInsuranceMaLevel)} cancelled.`);
  }

  return buildPnlMessage(
    `${EMOJI_CROSS} ${formatTimeframe(timeframe)} ${formatClickableText(symbol)} ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, 'SOS cancelled'),
    bodyLineList,
  );
}

function formatTpCancelledMessage(args: TpCancelledMessageArgs): string {
  const { symbol, timeframe, direction, maLevel, isAugmented, cancelledCount, failedCount } = args;
  const bodyLineList: string[] = ['', 'Position remains open. Tap 💰 TP to create a new fan when ready.'];

  if (failedCount > 0) {
    bodyLineList.push(`${failedCount} rejected by exchange — OrderManager retries in background.`);
  }

  return buildPnlMessage(
    `${EMOJI_CROSS} ${formatTimeframe(timeframe)} ${formatClickableText(symbol)} ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, `${cancelledCount} TP orders cancelled`),
    bodyLineList,
  );
}

function formatPendingEntriesCancelledMessage(args: PendingEntriesCancelledMessageArgs): string {
  const { symbol, timeframe, direction, maLevel, isAugmented, cancelledCount } = args;
  const bodyLineList: string[] = ['', 'Position remains open. Pending multi-entry orders drained.'];

  return buildPnlMessage(
    `${EMOJI_CROSS} ${formatTimeframe(timeframe)} ${formatClickableText(symbol)} ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, `${cancelledCount} pending entry orders cancelled`),
    bodyLineList,
  );
}

function formatAutoTpMenuMessage(args: AutoTpMenuMessageArgs): string {
  const { symbol, direction, isTrailingSlEnabled, isPnlAlertsEnabled, isAutoCloseEnabled } = args;

  return [
    `${EMOJI_ROBOT} Auto TP — ${formatClickableText(symbol)} ${formatDirection(direction)}`,
    '',
    `Trailing SL: ${formatToggleStatus(isTrailingSlEnabled)}`,
    `PnL alerts: ${formatToggleStatus(isPnlAlertsEnabled)}`,
    `Auto-close: ${formatToggleStatus(isAutoCloseEnabled)}`,
  ].join('\n');
}

function formatToggleStatus(isOn: boolean): string {
  return isOn ? `ON ${EMOJI_CHECK}` : `OFF ${EMOJI_CROSS}`;
}

function formatHalfClosedMessage(args: HalfClosedMessageArgs): string {
  const { symbol, timeframe, direction, maLevel, entryPrice, pnlPercent, lastPrice, closedContracts, remainingContracts, isAugmented } = args;
  const pnlSign = pnlPercent >= 0 ? '+' : '';

  return buildPnlMessage(
    `${EMOJI_SCISSORS} ${formatTimeframe(timeframe)} \`${symbol}\` ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, `Half closed at breakeven (${pnlSign}${pnlPercent.toFixed(2)}%)`),
    [
      '',
      `Entry: \`${entryPrice}\``,
      `Closed: ${closedContracts} @ \`${lastPrice}\``,
      `Remaining: ${remainingContracts}`,
      'Monitoring resumed — SOS available again',
    ],
  );
}

function formatPositionRemovedExternallyMessage(args: PositionRemovedExternallyMessageArgs): string {
  const { symbol, timeframe, direction, maLevel, isAugmented, lastPnlPercent, confirmationTickCount, confirmationWindowSeconds } = args;
  const pnlSign = lastPnlPercent !== null && lastPnlPercent >= 0 ? '+' : '';
  const pnlText = lastPnlPercent !== null ? `${pnlSign}${lastPnlPercent.toFixed(2)}%` : 'n/a';

  return buildPnlMessage(
    `${EMOJI_INFO} ${formatTimeframe(timeframe)} \`${symbol}\` ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, 'Position removed from monitoring'),
    [
      '',
      `Exchange reported contracts=0 for ${confirmationTickCount} consecutive polls (~${confirmationWindowSeconds}s).`,
      `Last known PNL: ${pnlText}`,
      'SL / TP / multi-entry / insurance chaser cancelled (if any).',
    ],
  );
}

function formatExternalMultiEntryCancelMessage(args: ExternalMultiEntryCancelMessageArgs): string {
  const { symbol, timeframe, direction, maLevel, isAugmented, cancelledCount, remainingCount, cancelType } = args;

  return buildPnlMessage(
    `${EMOJI_WARNING} ${formatTimeframe(timeframe)} \`${symbol}\` ${formatDirection(direction)}`,
    buildHeaderTail(maLevel, isAugmented, `${cancelledCount} entry order(s) cancelled outside the bot`),
    [
      '',
      `cancelType: ${cancelType ?? 'unknown'}`,
      `Remaining pending entries: ${remainingCount}`,
      'Position itself is unaffected — monitoring continues.',
    ],
  );
}

export {
  buildHeaderTail,
  buildPnlMessage,
  formatExternalMultiEntryCancelMessage,
  formatProfitAlertMessage,
  formatLossAlertMessage,
  formatAutoCloseMessage,
  formatAutoTpMenuMessage,
  formatPositionClosedMessage,
  formatAutoCloseCancelledMessage,
  formatPositionsListMessage,
  formatPositionDetailMessage,
  formatEphemeralPositionDetailMessage,
  formatTpSplitConfirmation,
  formatTpSplitCreatedMessage,
  formatInsuranceFilledMessage,
  formatInsuranceAdditionalFillMessage,
  formatSosMarkedMessage,
  formatSosCancelledMessage,
  formatTpCancelledMessage,
  formatPendingEntriesCancelledMessage,
  formatPositionAugmentedMessage,
  formatHalfClosedMessage,
  formatPositionRemovedExternallyMessage,
};
